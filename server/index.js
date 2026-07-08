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
const autoSyncWebhook = require("./services/autoSyncWebhook");
const autoSyncQueue = require("./services/autoSyncQueue");
const autoSyncReconciliation = require("./services/autoSyncReconciliation");

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

app.use("/api/collections", collectionsRouter);
app.get("/api/backlog", collectionsRouter.backlogHandler);
app.use("/api/sync", syncRouter);
app.use("/api/sync/pages", syncPagesRouter);
app.use("/api/sync/components", syncComponentsRouter);
app.use("/api/automations", automationsRouter);
app.use("/api/webhooks", webhooksRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/config", configRouter);

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
 * One-time migration of the old singleton Auto Sync config into the new
 * automations table, run once at startup. The new CMS content-scope shape
 * mirrors the old settings.autoSync shape field-for-field, so this is a
 * direct copy, not a rebuild. Deliberately always `type: "cms"`, never
 * "all" -- the old config never had Pages/Components scope, so mapping it
 * to "all" would silently expand scope to content the user never opted
 * into. No-ops if there's nothing to migrate or automations already exist.
 */
async function migrateLegacyAutoSyncIfNeeded() {
  const settings = await store.getSettings();
  const legacy = settings.autoSync;
  if (!legacy) return;

  const existing = await store.listAutomations();
  if (existing.length > 0) return;

  const automation = await store.createAutomation({
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
    await store.updateAutomation(automation.id, { contentScope: { scope: "leaves", leaves: [], _expandAllCollections: true } });
  }
  console.log(`Migrated legacy Auto Sync config into automation "${automation.name}" (${automation.id})`);

  await store.updateSettings({ autoSync: null, autoSyncReconciliation: null });
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
async function migrateAutomationsToLeafShapeIfNeeded() {
  const automations = await store.listAutomations();
  for (const automation of automations) {
    const scope = automation.contentScope;
    const isLegacyShape = scope.type !== undefined;
    const needsExpansion = scope._expandAllCollections;
    if (!isLegacyShape && !needsExpansion) continue;

    let leaves = scope.leaves || [];
    if (isLegacyShape) {
      if (scope.type === "all") {
        await store.updateAutomation(automation.id, { contentScope: { scope: "all" } });
        continue;
      }
      leaves = (scope.enabledCollectionIds || []).map((id) => ({
        kind: "collection",
        id,
        filters: (scope.fieldConditions || {})[id] || [],
      }));
      if (!scope.allCollectionsEnabled) {
        await store.updateAutomation(automation.id, { contentScope: { scope: "leaves", leaves } });
        continue;
      }
    }

    // allCollectionsEnabled (old) or _expandAllCollections (transitional):
    // materialize every real collection as an explicit leaf.
    try {
      const collections = await webflow.listCollections();
      leaves = collections.map((c) => ({ kind: "collection", id: c.id, filters: [] }));
      await store.updateAutomation(automation.id, { contentScope: { scope: "leaves", leaves } });
      console.log(`Expanded automation "${automation.name}" (${automation.id}) to ${leaves.length} real collections`);
    } catch (err) {
      console.error(`Failed to expand automation "${automation.name}" to real collections:`, err.message);
    }
  }
}

db.migrate()
  .then(async () => {
    await migrateLegacyAutoSyncIfNeeded();
    await migrateAutomationsToLeafShapeIfNeeded();

    // Startup self-heal: register/teardown the shared Webflow webhook based
    // on current automations state, in case a prior process crashed
    // mid-registration or mid-teardown. Cheap and idempotent.
    const automations = await store.listAutomations();
    const anyNeedsWebhook = automations.some(
      (a) => a.enabled && !a.archived && (a.contentScope.scope === "all" || (a.contentScope.leaves || []).some((l) => l.kind === "collection"))
    );
    if (anyNeedsWebhook) {
      autoSyncWebhook.ensureWebhookRegistered().catch((err) => console.error("Automation webhook self-heal failed:", err.message));
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
