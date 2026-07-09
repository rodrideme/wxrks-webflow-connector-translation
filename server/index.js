require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");

const db = require("./db");
const store = require("./store");
const webflow = require("./services/webflow");
const collectionsRouter = require("./routes/collections");
const syncRouter = require("./routes/sync");
const syncPagesRouter = require("./routes/syncPages");
const syncComponentsRouter = require("./routes/syncComponents");
const automationsRouter = require("./routes/automations");
const webhooksRouter = require("./routes/webhooks");
const settingsRouter = require("./routes/settings");
const configRouter = require("./routes/config");
const slugSuggestionsRouter = require("./routes/slugSuggestions");
const authRouter = require("./routes/auth");
const { requireSession } = require("./middleware/auth");
const autoSyncWebhook = require("./services/autoSyncWebhook");
const autoSyncQueue = require("./services/autoSyncQueue");
const autoSyncReconciliation = require("./services/autoSyncReconciliation");
const accountContext = require("./services/accountContext");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// Captures the raw request body buffer alongside the parsed JSON -- needed
// to verify the Webflow webhook's HMAC signature, which is computed over
// the exact bytes received, not a re-serialized version of req.body. A
// no-op for every other route, since nothing else reads req.rawBody.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// RENDER_GIT_COMMIT is set automatically by Render for git-deployed services;
// falls back to a local git lookup for dev. Lets us verify which commit is
// actually live instead of inferring it from deploy logs/timestamps.
const deployedCommit = (() => {
  if (process.env.RENDER_GIT_COMMIT) return process.env.RENDER_GIT_COMMIT;
  try {
    return require("child_process").execSync("git rev-parse HEAD").toString().trim();
  } catch {
    return "unknown";
  }
})();

app.get("/api/health", (req, res) => res.json({ status: "ok", commit: deployedCommit }));

// Unauthenticated: the OAuth login/callback flow itself, and Webflow/wxrks's
// own webhook deliveries (HMAC/signature-verified inside routes/webhooks.js,
// not session-based -- a webhook has no browser session to present).
app.use("/api/auth", authRouter);
app.use("/api/webhooks", webhooksRouter);

// Every other /api/* route requires a valid session (see middleware/auth.js)
// -- req.account.id, populated here, is what every route handler below
// scopes its store.js calls by.
app.use("/api", requireSession);

app.use("/api/collections", collectionsRouter);
app.get("/api/backlog", collectionsRouter.backlogHandler);
app.use("/api/sync", syncRouter);
app.use("/api/sync/pages", syncPagesRouter);
app.use("/api/sync/components", syncComponentsRouter);
app.use("/api/automations", automationsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/config", configRouter);
app.use("/api/slug-suggestions", slugSuggestionsRouter);

// Serve the built React app in production.
const clientDist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDist));
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

/**
 * Multi-user login (Phase 1) bootstrap: every pre-existing row in
 * app_state/project_mappings/automations predates the `accounts` concept
 * entirely (account_id is NULL on all of them). This runs before anything
 * else at startup, creates "Account #1" for the site this install has
 * always pointed at (WEBFLOW_SITE_ID), backfills account_id onto every
 * existing row, and finalizes app_state's uniqueness constraint from a
 * single global row per key to one row per (account, key) -- required
 * before a second account could ever have its own settings row. Idempotent:
 * on every later boot this is a fast no-op (account already exists, no NULL
 * rows left, constraint already finalized).
 *
 * Returns the resolved account id, used to scope the legacy migrations
 * below (which ran against the single global dataset before accounts
 * existed, and now need to know which account that dataset became).
 */
async function migrateSingleTenantToAccountOne() {
  const webflowSiteId = process.env.WEBFLOW_SITE_ID;
  if (!webflowSiteId) {
    console.warn("WEBFLOW_SITE_ID not set -- skipping single-tenant-to-account bootstrap; no account exists yet.");
    return null;
  }

  let account = await store.getAccountByWebflowSiteId(webflowSiteId);
  if (!account) {
    account = await store.createAccount({ webflowSiteId });
    console.log(`Created Account #1 for Webflow site ${webflowSiteId} (${account.id})`);
  }

  // Raw SQL, not store.js's functions -- those all require an accountId now,
  // and this is the one-time bootstrap that supplies it for the first time.
  await db.query(`UPDATE app_state SET account_id = $1 WHERE account_id IS NULL`, [account.id]);
  await db.query(`UPDATE project_mappings SET account_id = $1 WHERE account_id IS NULL`, [account.id]);
  await db.query(`UPDATE automations SET account_id = $1 WHERE account_id IS NULL`, [account.id]);

  const { rows: pkRows } = await db.query(
    `SELECT constraint_name FROM information_schema.table_constraints
     WHERE table_name = 'app_state' AND constraint_type = 'PRIMARY KEY'`
  );
  const { rows: pkColRows } = pkRows[0]
    ? await db.query(
        `SELECT column_name FROM information_schema.key_column_usage WHERE table_name = 'app_state' AND constraint_name = $1`,
        [pkRows[0].constraint_name]
      )
    : { rows: [] };
  const currentPkColumns = pkColRows.map((r) => r.column_name).sort().join(",");
  if (currentPkColumns !== "account_id,key") {
    if (pkRows[0]) await db.query(`ALTER TABLE app_state DROP CONSTRAINT ${pkRows[0].constraint_name}`);
    await db.query(`ALTER TABLE app_state ADD PRIMARY KEY (account_id, key)`);
    console.log("Finalized app_state's primary key to (account_id, key)");
  }

  return account.id;
}

/**
 * One-time migration of the old singleton Auto Sync config into the new
 * automations table, run once at startup. The new CMS content-scope shape
 * mirrors the old settings.autoSync shape field-for-field, so this is a
 * direct copy, not a rebuild. Deliberately always `type: "cms"`, never
 * "all" -- the old config never had Pages/Components scope, so mapping it
 * to "all" would silently expand scope to content the user never opted
 * into. No-ops if there's nothing to migrate or automations already exist.
 */
async function migrateLegacyAutoSyncIfNeeded(accountId) {
  const settings = await store.getSettings(accountId);
  const legacy = settings.autoSync;
  if (!legacy) return;

  const existing = await store.listAutomations(accountId);
  if (existing.length > 0) return;

  const automation = await store.createAutomation(accountId, {
    name: "Auto Sync (migrated)",
    enabled: legacy.enabled,
    contentScope: {
      scope: "leaves",
      leaves: legacy.allCollectionsEnabled
        ? [] // materialized to real collection ids by migrateAutomationsToLeafShapeIfNeeded below
        : legacy.enabledCollectionIds.map((id) => ({
            kind: "collection",
            id,
            filters: legacy.fieldConditions[id] || [],
          })),
    },
    cadence: legacy.flushTimes,
    orgUnitOverride: null,
  });
  // Old "all collections enabled" has no equivalent in the new leaves-only
  // shape without enumerating real collections -- stash the flag so the
  // very next migration step (which can make a live Webflow call) expands it.
  if (legacy.allCollectionsEnabled) {
    await store.updateAutomation(accountId, automation.id, { contentScope: { scope: "leaves", leaves: [], _expandAllCollections: true } });
  }
  console.log(`Migrated legacy Auto Sync config into automation "${automation.name}" (${automation.id})`);

  await store.updateSettings(accountId, { autoSync: null, autoSyncReconciliation: null });
}

/**
 * Upgrades any automation row still carrying the pre-"Sync Panel - Ledger"
 * contentScope shape (`{type: "cms"|"all", allCollectionsEnabled,
 * enabledCollectionIds, fieldConditions}`, or the transitional
 * `_expandAllCollections` marker above) into the current leaf+filter shape
 * (`{scope: "all"|"leaves", leaves: [{kind, id, filters}]}`). Cheap no-op
 * for every row once migrated. `cadence` itself needs no explicit migration
 * -- store.js's automationRowToObject already derives it from the legacy
 * flush_times column for any row where the cadence column is still null.
 */
async function migrateAutomationsToLeafShapeIfNeeded(accountId) {
  const automations = await store.listAutomations(accountId);
  for (const automation of automations) {
    const scope = automation.contentScope;
    const isLegacyShape = scope.type !== undefined;
    const needsExpansion = scope._expandAllCollections;
    if (!isLegacyShape && !needsExpansion) continue;

    let leaves = scope.leaves || [];
    if (isLegacyShape) {
      if (scope.type === "all") {
        await store.updateAutomation(accountId, automation.id, { contentScope: { scope: "all" } });
        continue;
      }
      leaves = (scope.enabledCollectionIds || []).map((id) => ({
        kind: "collection",
        id,
        filters: (scope.fieldConditions || {})[id] || [],
      }));
      if (!scope.allCollectionsEnabled) {
        await store.updateAutomation(accountId, automation.id, { contentScope: { scope: "leaves", leaves } });
        continue;
      }
    }

    // allCollectionsEnabled (old) or _expandAllCollections (transitional):
    // materialize every real collection as an explicit leaf. Runs before
    // the self-heal loop below establishes any account context, so this
    // needs its own -- webflow.listCollections() now resolves per-account
    // credentials via accountContext (see services/webflow.js).
    try {
      const collections = await accountContext.run(accountId, () => webflow.listCollections());
      leaves = collections.map((c) => ({ kind: "collection", id: c.id, filters: [] }));
      await store.updateAutomation(accountId, automation.id, { contentScope: { scope: "leaves", leaves } });
      console.log(`Expanded automation "${automation.name}" (${automation.id}) to ${leaves.length} real collections`);
    } catch (err) {
      console.error(`Failed to expand automation "${automation.name}" to real collections:`, err.message);
    }
  }
}

db.migrate()
  .then(async () => {
    const accountId = await migrateSingleTenantToAccountOne();
    if (accountId) {
      await migrateLegacyAutoSyncIfNeeded(accountId);
      await migrateAutomationsToLeafShapeIfNeeded(accountId);
    }

    // Startup self-heal: register/teardown each account's shared Webflow
    // webhooks based on its current automations state, in case a prior
    // process crashed mid-registration or mid-teardown. Cheap and
    // idempotent, iterated per account (see autoSyncQueue.js's flush loop
    // for the same reasoning).
    const accounts = await store.listAllAccounts();
    for (const account of accounts) {
      await accountContext.run(account.id, async () => {
        const automations = await store.listAutomations(account.id);
        const anyNeedsWebhook = automations.some(
          (a) => a.enabled && !a.archived && (a.contentScope.scope === "all" || (a.contentScope.leaves || []).some((l) => l.kind === "collection"))
        );
        if (anyNeedsWebhook) {
          autoSyncWebhook
            .ensureWebhookRegistered(account.id)
            .catch((err) => console.error(`Automation webhook self-heal failed for account ${account.id}:`, err.message));
        }
        const anyNeedsPagesWebhook = automations.some(
          (a) =>
            a.enabled &&
            !a.archived &&
            (a.contentScope.scope === "all" || (a.contentScope.leaves || []).some((l) => l.kind === "pagesFolder" || l.kind === "components"))
        );
        if (anyNeedsPagesWebhook) {
          autoSyncWebhook
            .ensurePagesWebhookRegistered(account.id)
            .catch((err) => console.error(`Pages webhook self-heal failed for account ${account.id}:`, err.message));
        }
      });
    }

    autoSyncQueue.startFlushLoop();
    autoSyncReconciliation.startReconciliationLoop();

    app.listen(PORT, () => {
      console.log(`Webflow Translation Sync server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to run database migrations:", err.message);
    process.exit(1);
  });
