/**
 * Persisted state (settings, sync history) lives in Postgres via db.js, so it
 * survives process restarts and Render deploys. Sync-job progress tracking
 * stays in-memory: it's only meaningful for the lifetime of the background
 * loop driving it in this process anyway -- a restart kills that loop
 * regardless of where its progress was recorded.
 *
 * Multi-user login: every persisted table is scoped by `account_id` (one
 * account = one connected Webflow site). Nearly every function below takes
 * `accountId` as its first argument and filters/writes through it -- this
 * is what makes two different accounts' data fully isolated from each
 * other. Both Webflow (Phase 2) and wxrks (Phase 3) API credentials are
 * now per-account too (see webflow_connections/wxrks_connections below),
 * each falling back to the original global env vars only for the one
 * account that predates the accounts system entirely -- see
 * services/webflow.js's/wxrks.js's resolveConnection().
 */

const crypto = require("crypto");
const db = require("./db");
const {
  DEFAULT_WORK_UNIT_NAME_PATTERN,
  DEFAULT_PAGE_WORK_UNIT_NAME_PATTERN,
  DEFAULT_COMPONENT_WORK_UNIT_NAME_PATTERN,
} = require("./services/webflow");
const { evaluateCondition } = require("./services/autoSyncRules");

const DEFAULT_SETTINGS = {
  sourceLocale: process.env.SOURCE_LOCALE || "en",
  targetLocales: [],
  // IANA timezone (e.g. "America/Sao_Paulo"). App-wide: interprets Auto
  // Sync's flushTimes as wall-clock times in this zone, and is used to
  // render every date/time shown in the UI consistently for all viewers
  // (rather than each browser's own local zone).
  timezone: "UTC",
  autoPublish: process.env.AUTO_PUBLISH === "true",
  autoApprove: false,
  // A one-time send spanning multiple collections/pages/components used to
  // always create one wxrks project per group (confirmed live: selecting
  // items from 2 collections created 2 separate projects) -- default now
  // combines everything into a single project instead, matching how
  // automations already behave (autoSyncQueue.flush() always shares one
  // project across a whole batch regardless of entity type). Turning this
  // off restores the old per-group behavior, with each project's name
  // auto-suffixed "(1 of N)" etc. so they're distinguishable.
  combineIntoOneProject: true,
  orgUnitUUID: process.env.WXRKS_ORG_UNIT_UUID || "",
  // { [collectionId]: string[] of field slugs to never translate, on top of
  // the automatic type-based filter }
  fieldExclusions: {},
  // { [componentId]: string[] of propertyIds to never translate -- unlike
  // fieldExclusions there's no automatic type-based filter underneath,
  // since a Component Property's type (Plain Text/Rich Text/Alt Text)
  // can't distinguish real text from a config value (e.g. "48px", raw
  // CSS) that merely happens to use the same type.
  componentPropertyExclusions: {},
  // Property labels containing any of these keywords (case-insensitive
  // substring match, stored lowercased) are auto-excluded from translation
  // on top of componentPropertyExclusions above -- the automatic layer
  // that covers the common case (a Property named "Logo width"/"Style"/
  // "quote width") without needing to manually toggle each one off.
  // Applies to both a component's own default properties and any page's
  // per-placement override of one.
  componentPropertyAutoExcludeKeywords: ["width", "class", "style"],
  // Controls whether/how a CMS item's Webflow slug is regenerated for each
  // target locale on write-back (see webhooks.js's wxrks-webhook handler).
  // "source": never touch the slug (today's behavior, default). "translate"/
  // "transliterate": derive a new slug from the item's name (translated or
  // transliterated respectively) -- never from the raw slug string itself,
  // since that's what caused slug translation to be hard-blocked before
  // (see NON_TRANSLATABLE_KEYS above) -- and write it immediately alongside
  // the rest of that locale's translated fields.
  slugHandling: {
    mode: "source", // "source" | "translate" | "transliterate"
    maxLength: 60,
  },
  // Placeholders: {collection}, {entry}. Becomes the wxrks resource/work-
  // unit file name (wxrks has no separate "name" field -- it derives the
  // work unit name from the uploaded file name).
  workUnitNamePattern: DEFAULT_WORK_UNIT_NAME_PATTERN,
  // Placeholder: {page}. Kept separate from workUnitNamePattern since the
  // token vocabulary differs (a page has no collection/entry distinction).
  pagesWorkUnitNamePattern: DEFAULT_PAGE_WORK_UNIT_NAME_PATTERN,
  // Placeholder: {component}. Components have no slug/entry token, only a
  // free-text `name` (e.g. "<Footer>", "Dark CTA") -- always slugified.
  componentsWorkUnitNamePattern: DEFAULT_COMPONENT_WORK_UNIT_NAME_PATTERN,
  // Automation (formerly "Auto Sync"): Webflow webhook lifecycle bookkeeping,
  // global because Webflow registers one webhook per trigger type per site
  // regardless of how many automations exist. Individual automations
  // (content scope, schedule, org-unit override, checkpoint/dedup state)
  // live in the `automations` table, not here -- see store.js's automation
  // CRUD functions below.
  autoSyncWebhook: {
    webflowWebhookId: null,
    signingSecret: null,
    registeredAt: null,
    lastEventAt: null,
    status: "not_registered", // "not_registered" | "active" | "deactivated" | "error"
    lastError: null,
  },
  // Pages/Components have no per-entity webhook in Webflow's API (confirmed
  // live) -- this registers the closest available signal, "site_publish"
  // (fires on any Designer publish action), used to trigger an immediate
  // scan+enqueue for Pages/Components automations instead of waiting for
  // their own cadence tick. Same shape as autoSyncWebhook, tracked
  // separately since each is its own Webflow webhook registration with its
  // own signing secret.
  sitePublishWebhook: {
    webflowWebhookId: null,
    signingSecret: null,
    registeredAt: null,
    lastEventAt: null,
    status: "not_registered",
    lastError: null,
  },
  // Unlike the two above, this isn't something this app can register itself
  // -- wxrks exposes no webhook-management API at all (confirmed against
  // their real API docs), so its delivery webhook is configured once,
  // manually, in wxrks's own dashboard. `lastEventAt` is the only signal
  // this app can offer: whether a real delivery has ever actually arrived,
  // updated in routes/webhooks.js's /wxrks handler once it resolves which
  // account a delivery belongs to (that handler has no account context
  // until then, unlike Webflow's per-account webhook URLs).
  wxrksWebhook: {
    lastEventAt: null,
  },
};

// jobId -> { id, mode, total, processed, results: [], status, cancelled, startedAt }
const syncJobs = new Map();

function mappingRowToObject(row) {
  return {
    wxrksProjectUUID: row.wxrks_project_uuid,
    accountId: row.account_id,
    mode: row.mode,
    sourceLocale: row.source_locale,
    targetLocales: row.target_locales,
    orgUnitUUID: row.org_unit_uuid,
    workUnitNamePattern: row.work_unit_name_pattern,
    collectionIds: row.collection_ids,
    items: row.items,
    status: row.status,
    wxrksStatus: row.wxrks_status,
    createdAt: row.created_at.toISOString(),
    // Webhook-triggered "translations pushed back to Webflow" events, kept
    // separate from `items` (which records what was *sent* to wxrks).
    updates: row.updates || [],
    // Set only for mode "automation" -- the automation's name at the time it
    // ran (not a foreign key: automations are deletable and history must
    // stay attributable after deletion).
    automationName: row.automation_name || null,
    // The wxrks project's own `reference` string (see wxrks.createProject),
    // cached locally at creation time -- wxrks's own GET /project/:uuid
    // already echoes it back, so this is never re-derived, just a local
    // copy so the Runs page doesn't need a live wxrks call to show it. Runs
    // created before this column existed are simply null (Runs.jsx falls
    // back to showing the project uuid instead).
    reference: row.reference || null,
  };
}

async function createProjectMapping(accountId, wxrksProjectUUID, mapping) {
  const { rows } = await db.query(
    `INSERT INTO project_mappings
       (wxrks_project_uuid, account_id, mode, source_locale, target_locales, org_unit_uuid,
        work_unit_name_pattern, collection_ids, items, status, wxrks_status, automation_name, reference)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      wxrksProjectUUID,
      accountId,
      mapping.mode || "item",
      mapping.sourceLocale,
      JSON.stringify(mapping.targetLocales || []),
      mapping.orgUnitUUID,
      mapping.workUnitNamePattern,
      JSON.stringify(mapping.collectionIds || []),
      JSON.stringify(mapping.items || []),
      mapping.status || "in_progress",
      mapping.wxrksStatus || "DRAFT",
      mapping.automationName || null,
      mapping.reference || null,
    ]
  );
  return mappingRowToObject(rows[0]);
}

/**
 * Appends one Webflow item's resource to an existing batch mapping and
 * tracks its collection in `collectionIds`. Used to build up the mapping
 * incrementally as a bulk/batch sync processes each item, so a mid-run
 * cancellation still leaves an accurate record of what was actually synced.
 *
 * `wxrks_project_uuid` is already globally unique (assigned by wxrks
 * itself), so no accountId is needed to find the row -- but every caller
 * that has one in scope should still pass it for defense-in-depth (the
 * wxrks webhook handler is the one legitimate exception: it doesn't know
 * the account in advance and reads it *from* the fetched row instead, see
 * routes/webhooks.js).
 */
async function addItemToProjectMapping(
  wxrksProjectUUID,
  {
    entityType,
    webflowCollectionId,
    webflowItemId,
    webflowPageId,
    webflowComponentId,
    resourceId,
    resourceFileName,
    fieldKeys,
    wordCount,
    sourceName,
    sourceSlug,
    previewUrl,
  }
) {
  const existing = await getProjectMapping(wxrksProjectUUID);
  if (!existing) return undefined;

  // Pages/Components have no collectionId -- only track one when this is a CMS item.
  const collectionIds =
    webflowCollectionId && !existing.collectionIds.includes(webflowCollectionId)
      ? [...existing.collectionIds, webflowCollectionId]
      : existing.collectionIds;

  return updateProjectMapping(wxrksProjectUUID, {
    collectionIds,
    items: [
      ...existing.items,
      // entityType defaults to "cmsItem" for backward compat with rows
      // written before this discriminator existed.
      {
        entityType: entityType || "cmsItem",
        webflowCollectionId,
        webflowItemId,
        webflowPageId,
        webflowComponentId,
        resourceId,
        resourceFileName,
        fieldKeys,
        wordCount,
        sourceName,
        sourceSlug,
        previewUrl,
      },
    ],
  });
}

/**
 * Appends one "translations pushed back to Webflow" event to a batch
 * mapping's `updates` log -- distinct from `items` (what was sent to
 * wxrks). A project could in principle receive more than one webhook call,
 * so this is a list, not a single field.
 */
async function addWebflowUpdateToProjectMapping(wxrksProjectUUID, update) {
  const existing = await getProjectMapping(wxrksProjectUUID);
  if (!existing) return undefined;

  return updateProjectMapping(wxrksProjectUUID, {
    updates: [...existing.updates, { ...update, updatedAt: new Date().toISOString() }],
  });
}

// Keyed by the globally-unique wxrks_project_uuid -- no accountId needed to
// find the row (see the wxrks webhook handler, which doesn't know the
// account in advance and reads `accountId` off the returned object instead).
async function getProjectMapping(wxrksProjectUUID) {
  const { rows } = await db.query(`SELECT * FROM project_mappings WHERE wxrks_project_uuid = $1`, [
    wxrksProjectUUID,
  ]);
  return rows[0] ? mappingRowToObject(rows[0]) : undefined;
}

const PATCH_COLUMNS = {
  status: "status",
  wxrksStatus: "wxrks_status",
  collectionIds: "collection_ids",
  items: "items",
  updates: "updates",
};

const JSON_PATCH_KEYS = new Set(["collectionIds", "items", "updates"]);

async function updateProjectMapping(wxrksProjectUUID, patch) {
  const keys = Object.keys(patch).filter((k) => PATCH_COLUMNS[k]);
  if (keys.length === 0) return getProjectMapping(wxrksProjectUUID);

  const setClauses = keys.map((key, i) => `${PATCH_COLUMNS[key]} = $${i + 2}`);
  const values = keys.map((key) => (JSON_PATCH_KEYS.has(key) ? JSON.stringify(patch[key]) : patch[key]));

  const { rows } = await db.query(
    `UPDATE project_mappings SET ${setClauses.join(", ")} WHERE wxrks_project_uuid = $1 RETURNING *`,
    [wxrksProjectUUID, ...values]
  );
  return rows[0] ? mappingRowToObject(rows[0]) : undefined;
}

async function listProjectMappings(accountId) {
  const { rows } = await db.query(`SELECT * FROM project_mappings WHERE account_id = $1 ORDER BY created_at DESC`, [
    accountId,
  ]);
  return rows.map(mappingRowToObject);
}

async function listActiveProjects(accountId) {
  const { rows } = await db.query(
    `SELECT * FROM project_mappings WHERE account_id = $1 AND status = 'in_progress' ORDER BY created_at DESC`,
    [accountId]
  );
  return rows.map(mappingRowToObject);
}

/**
 * Per-entity, per-locale delivery status derived from every project
 * mapping's `updates[]` log (real push-back attempts, whether they
 * succeeded or errored) -- the source of truth for the new/stale/failed/
 * synced status model. `idField` is whichever of `webflowItemId`/
 * `webflowPageId`/`webflowComponentId` identifies the entity kind being
 * asked about. Keeps only the most recent attempt per (entity, locale),
 * since an earlier failure followed by a later success should read as
 * synced, not failed.
 */
async function getDeliveryStatusByEntity(accountId, idField) {
  const mappings = await listProjectMappings(accountId);
  const statusMap = {};
  for (const mapping of mappings) {
    for (const update of mapping.updates || []) {
      for (const resultEntry of update.resultsByItem || []) {
        const entityId = resultEntry[idField];
        if (!entityId) continue;
        for (const rl of resultEntry.resultsByLocale || []) {
          const existing = statusMap[entityId]?.[rl.locale];
          if (!existing || new Date(update.updatedAt) > new Date(existing.updatedAt)) {
            statusMap[entityId] = { ...statusMap[entityId], [rl.locale]: { error: rl.error || null, updatedAt: update.updatedAt } };
          }
        }
      }
    }
  }
  return statusMap;
}

/**
 * Same "most recent attempt per (entity, locale)" reduction as
 * getDeliveryStatusByEntity, scoped to one already-loaded mapping's own
 * updates[] instead of scanning every mapping account-wide, and generic
 * across entity kinds (a mapping can mix CMS items/pages/components, e.g.
 * a "combined" sync) rather than requiring one specific idField -- each
 * resultsByItem[] entry only ever has one of webflowItemId/webflowPageId/
 * webflowComponentId populated, so this just takes whichever is present.
 * Used by the Runs page's per-run work-unit list.
 */
function latestUpdateByEntityAndLocale(mapping) {
  const result = {};
  for (const update of mapping.updates || []) {
    for (const resultEntry of update.resultsByItem || []) {
      const entityId = resultEntry.webflowItemId || resultEntry.webflowPageId || resultEntry.webflowComponentId;
      if (!entityId) continue;
      for (const rl of resultEntry.resultsByLocale || []) {
        const existing = result[entityId]?.[rl.locale];
        if (!existing || new Date(update.updatedAt) > new Date(existing.updatedAt)) {
          result[entityId] = { ...result[entityId], [rl.locale]: { error: rl.error || null, updatedAt: update.updatedAt } };
        }
      }
    }
  }
  return result;
}

/**
 * Combines a delivery-log entry (if any) with the source's own last-updated
 * timestamp into one of the design's four states: failed (last delivery
 * attempt errored), new (never delivered, and Webflow shows no non-draft
 * locale content either), stale (delivered before, but the source has
 * changed since), synced (up to date). `localeExists`/`localeIsDraft` only
 * apply to CMS items (Pages/Components have no per-locale item to check,
 * so pass `localeExists: true, localeIsDraft: false` for those -- their
 * "ever delivered" signal comes entirely from the delivery log instead).
 */
function computeLocaleStatus({ delivery, sourceLastUpdated, localeExists, localeIsDraft }) {
  if (delivery?.error) return { status: "failed", error: delivery.error };
  if (!delivery) return { status: localeExists && !localeIsDraft ? "synced" : "new" };
  if (sourceLastUpdated && new Date(sourceLastUpdated) > new Date(delivery.updatedAt)) return { status: "stale" };
  return { status: "synced" };
}

function mergeSettings(stored) {
  // A plain top-level spread is enough for flat fields, but nested objects
  // need their own merge so a stored row that only ever had a partial
  // sub-object written (e.g. before a field existed) doesn't lose those
  // nested defaults entirely instead of falling back to them.
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  merged.autoSyncWebhook = {
    ...DEFAULT_SETTINGS.autoSyncWebhook,
    ...(stored.autoSyncWebhook || {}),
  };
  merged.sitePublishWebhook = {
    ...DEFAULT_SETTINGS.sitePublishWebhook,
    ...(stored.sitePublishWebhook || {}),
  };
  merged.wxrksWebhook = {
    ...DEFAULT_SETTINGS.wxrksWebhook,
    ...(stored.wxrksWebhook || {}),
  };
  merged.slugHandling = {
    ...DEFAULT_SETTINGS.slugHandling,
    ...(stored.slugHandling || {}),
  };
  return merged;
}

// app_state's PK is (account_id, key) -- one 'settings'/'lastSync'/
// 'debugWebhookHistory' row per account, not one globally. See
// migrateSingleTenantToAccountOne() in index.js for how existing
// installs' single global row set became "Account #1"'s rows.
async function getSettings(accountId) {
  const { rows } = await db.query(`SELECT value FROM app_state WHERE account_id = $1 AND key = 'settings'`, [
    accountId,
  ]);
  // Merge over defaults so a settings field added after a row was first
  // written still gets a sane value instead of undefined for existing
  // installs.
  if (rows[0]) return mergeSettings(rows[0].value);

  // WXRKS_ORG_UNIT_UUID is the developer's own org unit -- only seed it as
  // this account's default when it IS the developer's own (original)
  // account. Any other (new) account starts with no default org unit
  // instead of silently pointing at an org unit its own wxrks credentials
  // (once connected) won't have access to -- see services/wxrks.js's
  // resolveConnection() for the equivalent credential-side scoping.
  const account = await getAccount(accountId);
  const isOriginalAccount = account?.webflowSiteId && account.webflowSiteId === process.env.WEBFLOW_SITE_ID;
  const defaults = isOriginalAccount ? DEFAULT_SETTINGS : { ...DEFAULT_SETTINGS, orgUnitUUID: "" };

  await db.query(
    `INSERT INTO app_state (account_id, key, value) VALUES ($1, 'settings', $2) ON CONFLICT (account_id, key) DO NOTHING`,
    [accountId, JSON.stringify(defaults)]
  );
  return defaults;
}

async function updateSettings(accountId, patch) {
  const current = await getSettings(accountId);
  const updated = { ...current, ...patch };
  await db.query(
    `INSERT INTO app_state (account_id, key, value) VALUES ($1, 'settings', $2)
     ON CONFLICT (account_id, key) DO UPDATE SET value = $2`,
    [accountId, JSON.stringify(updated)]
  );
  return updated;
}

async function getFieldExclusions(accountId, collectionId) {
  const settings = await getSettings(accountId);
  return settings.fieldExclusions[collectionId] || [];
}

async function setFieldExclusions(accountId, collectionId, excludedFields) {
  const settings = await getSettings(accountId);
  const fieldExclusions = { ...settings.fieldExclusions, [collectionId]: excludedFields };
  await updateSettings(accountId, { fieldExclusions });
  return excludedFields;
}

async function getComponentPropertyExclusions(accountId, componentId) {
  const settings = await getSettings(accountId);
  return settings.componentPropertyExclusions[componentId] || [];
}

async function setComponentPropertyExclusions(accountId, componentId, excludedPropertyIds) {
  const settings = await getSettings(accountId);
  const componentPropertyExclusions = { ...settings.componentPropertyExclusions, [componentId]: excludedPropertyIds };
  await updateSettings(accountId, { componentPropertyExclusions });
  return excludedPropertyIds;
}

/**
 * Read-modify-write onto the freshly-read current settings, used only by
 * server-side webhook lifecycle code (registration, reconciliation's
 * deactivation inference) -- kept separate from the general updateSettings()
 * PUT path so a client Settings save racing a server-side webhook-status
 * update can't clobber it.
 */
async function updateAutoSyncWebhookState(accountId, patch) {
  const settings = await getSettings(accountId);
  const autoSyncWebhook = { ...settings.autoSyncWebhook, ...patch };
  await updateSettings(accountId, { autoSyncWebhook });
  return autoSyncWebhook;
}

async function updateSitePublishWebhookState(accountId, patch) {
  const settings = await getSettings(accountId);
  const sitePublishWebhook = { ...settings.sitePublishWebhook, ...patch };
  await updateSettings(accountId, { sitePublishWebhook });
  return sitePublishWebhook;
}

async function updateWxrksWebhookState(accountId, patch) {
  const settings = await getSettings(accountId);
  const wxrksWebhook = { ...settings.wxrksWebhook, ...patch };
  await updateSettings(accountId, { wxrksWebhook });
  return wxrksWebhook;
}

// ---------------------------------------------------------------------------
// Accounts / users / sessions (multi-user login)

function accountRowToObject(row) {
  return {
    id: row.id,
    name: row.name,
    webflowSiteId: row.webflow_site_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function userRowToObject(row) {
  return {
    id: row.id,
    webflowUserId: row.webflow_user_id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
  };
}

async function getAccountByWebflowSiteId(webflowSiteId) {
  const { rows } = await db.query(`SELECT * FROM accounts WHERE webflow_site_id = $1`, [webflowSiteId]);
  return rows[0] ? accountRowToObject(rows[0]) : undefined;
}

async function getAccount(accountId) {
  const { rows } = await db.query(`SELECT * FROM accounts WHERE id = $1`, [accountId]);
  return rows[0] ? accountRowToObject(rows[0]) : undefined;
}

async function createAccount({ webflowSiteId, name }) {
  const { rows } = await db.query(
    `INSERT INTO accounts (id, webflow_site_id, name) VALUES ($1, $2, $3) RETURNING *`,
    [crypto.randomUUID(), webflowSiteId, name || null]
  );
  return accountRowToObject(rows[0]);
}

// Every account, active or not -- for the background scheduler/reconciler
// loops (autoSyncQueue.js, autoSyncReconciliation.js), which need to run
// their per-account cycle across all of them, not any one user's session.
async function listAllAccounts() {
  const { rows } = await db.query(`SELECT * FROM accounts WHERE status = 'active' ORDER BY created_at ASC`);
  return rows.map(accountRowToObject);
}

async function getUserByWebflowUserId(webflowUserId) {
  const { rows } = await db.query(`SELECT * FROM users WHERE webflow_user_id = $1`, [webflowUserId]);
  return rows[0] ? userRowToObject(rows[0]) : undefined;
}

async function upsertUser({ webflowUserId, email, firstName, lastName }) {
  const { rows } = await db.query(
    `INSERT INTO users (id, webflow_user_id, email, first_name, last_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (webflow_user_id) DO UPDATE SET email = $3, first_name = $4, last_name = $5, updated_at = now()
     RETURNING *`,
    [crypto.randomUUID(), webflowUserId, email, firstName || null, lastName || null]
  );
  return userRowToObject(rows[0]);
}

/**
 * Deliberately separate from getUserByWebflowUserId/upsertUser's plain
 * userRowToObject shape -- this is the ONE place password_hash ever leaves
 * the database, for routes/auth.js's login route to verify against. Never
 * reuse this for anything that returns to the client; use
 * getUserByWebflowUserId or the plain user object other functions already
 * return instead.
 */
async function getUserForLogin(email) {
  const { rows } = await db.query(`SELECT * FROM users WHERE email = $1 AND password_hash IS NOT NULL`, [email]);
  if (!rows[0]) return undefined;
  return { ...userRowToObject(rows[0]), passwordHash: rows[0].password_hash };
}

async function setUserPassword(userId, passwordHash) {
  await db.query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [passwordHash, userId]);
}

/**
 * Adds (or confirms) a user's membership in an account -- this is the whole
 * mechanism behind "multiple users, same account": every login re-runs this
 * for whichever account(s) the Webflow OAuth grant's `siteIds` resolve to,
 * so a second teammate on the same site lands as a second member of the
 * *same* existing account row rather than creating a new one.
 */
async function upsertAccountMembership(accountId, userId, role = "member") {
  await db.query(
    `INSERT INTO account_users (account_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (account_id, user_id) DO NOTHING`,
    [accountId, userId, role]
  );
}

async function listAccountsForUser(userId) {
  const { rows } = await db.query(
    `SELECT a.*, au.role FROM accounts a
     JOIN account_users au ON au.account_id = a.id
     WHERE au.user_id = $1
     ORDER BY a.created_at ASC`,
    [userId]
  );
  return rows.map((row) => ({ ...accountRowToObject(row), role: row.role }));
}

/**
 * Everyone with access to this account, for the Teams page's member list.
 * role/accessLevel come straight off account_users -- see
 * getSessionWithUserAndAccount's doc comment for what each independently
 * gates.
 */
async function listAccountMembers(accountId) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.first_name, u.last_name, au.role, au.access_level, au.created_at AS joined_at
     FROM account_users au
     JOIN users u ON u.id = au.user_id
     WHERE au.account_id = $1
     ORDER BY au.created_at ASC`,
    [accountId]
  );
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
    accessLevel: row.access_level,
    joinedAt: row.joined_at.toISOString(),
  }));
}

// Owner-only (enforced by requireOwner in the route, not here). Scoped by
// accountId in the WHERE clause so one account's owner can never reach
// into another account's membership row even given an arbitrary userId.
async function setAccountUserAccessLevel(accountId, userId, accessLevel) {
  await db.query(`UPDATE account_users SET access_level = $1 WHERE account_id = $2 AND user_id = $3`, [accessLevel, accountId, userId]);
}

async function recordActivity(accountId, userId, action, detail) {
  await db.query(`INSERT INTO activity_log (id, account_id, user_id, action, detail) VALUES ($1, $2, $3, $4, $5)`, [
    crypto.randomUUID(),
    accountId,
    userId || null,
    action,
    detail ? JSON.stringify(detail) : null,
  ]);
}

// No total-count query -- the client treats a full page (items.length ===
// limit) as "there might be more" and offers a Load more button, which is
// enough for an account-scoped activity log that's never going to be huge.
async function listActivity(accountId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT al.id, al.user_id, al.action, al.detail, al.created_at,
            u.email, u.first_name, u.last_name
     FROM activity_log al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE al.account_id = $1
     ORDER BY al.created_at DESC
     LIMIT $2 OFFSET $3`,
    [accountId, limit, offset]
  );
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    detail: row.detail,
    createdAt: row.created_at.toISOString(),
    user: row.user_id ? { id: row.user_id, email: row.email, firstName: row.first_name, lastName: row.last_name } : null,
  }));
}

async function createSession(userId, accountId, expiresAt) {
  const id = crypto.randomBytes(32).toString("hex");
  await db.query(`INSERT INTO sessions (id, user_id, account_id, expires_at) VALUES ($1, $2, $3, $4)`, [
    id,
    userId,
    accountId,
    expiresAt,
  ]);
  return id;
}

/**
 * Loads a session together with its user and (current) account in one call
 * -- this is the hot path, hit on every authenticated request. Expired
 * sessions are treated as not found (still physically deleted lazily here
 * rather than needing a separate cleanup job).
 */
async function getSessionWithUserAndAccount(sessionId) {
  const { rows } = await db.query(
    `SELECT s.*, u.webflow_user_id, u.email, u.first_name, u.last_name,
            a.name AS account_name, a.webflow_site_id, a.status AS account_status,
            (wc.account_id IS NOT NULL) AS has_wxrks_connection,
            au.role, au.access_level
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN accounts a ON a.id = s.account_id
     JOIN account_users au ON au.account_id = s.account_id AND au.user_id = s.user_id
     LEFT JOIN wxrks_connections wc ON wc.account_id = a.id AND wc.status = 'active'
     WHERE s.id = $1`,
    [sessionId]
  );
  const row = rows[0];
  if (!row) return undefined;
  if (new Date(row.expires_at) < new Date()) {
    await deleteSession(sessionId);
    return undefined;
  }
  // Only the developer's own original account (identified the same way
  // migrateSingleTenantToAccountOne() creates it) may fall back to the
  // shared env-var wxrks credentials -- every other account must connect
  // its own, surfaced here so the frontend can gate wxrks-dependent
  // actions without a live wxrks call (see services/wxrks.js's
  // resolveConnection() for the matching server-side check).
  const isOriginalAccount = row.webflow_site_id && row.webflow_site_id === process.env.WEBFLOW_SITE_ID;
  return {
    sessionId: row.id,
    user: { id: row.user_id, webflowUserId: row.webflow_user_id, email: row.email, firstName: row.first_name, lastName: row.last_name },
    account: {
      id: row.account_id,
      name: row.account_name,
      webflowSiteId: row.webflow_site_id,
      status: row.account_status,
      wxrksConnected: row.has_wxrks_connection || isOriginalAccount,
      // The one account that predates multi-tenancy entirely -- the only
      // account allowed to provision new environments for other, unrelated
      // companies (see middleware/auth.js's requireOriginalAccount and
      // routes/environments.js). Surfaced here so the client can hide that
      // nav item/page for every other account without a round trip.
      isOriginalAccount: Boolean(isOriginalAccount),
      // Which account_users row THIS session's user holds -- role gates
      // team management (Teams page), accessLevel gates read vs. write
      // everywhere else (see middleware/auth.js's requireOwner/
      // requireWriteAccess). Independent axes: an owner isn't automatically
      // exempt from being set to reviewer for day-to-day actions.
      role: row.role,
      accessLevel: row.access_level,
    },
  };
}

async function touchSession(sessionId) {
  await db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [sessionId]);
}

async function deleteSession(sessionId) {
  await db.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
}

// Used by routes/auth.js's reset-password: if a password needed resetting,
// whatever session(s) were active before shouldn't survive it (e.g. a
// compromised password implies a possibly-compromised existing session
// too). The fresh session created right after a reset is a new row, so
// this can never delete the one being logged into.
async function deleteSessionsForUser(userId) {
  await db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
}

// ---------------------------------------------------------------------------
// Password reset (routes/auth.js): short-lived, single-use tokens for
// users who set a password at invite redemption (routes/connect.js) --
// mirrors the Invites section below's single-use-gate pattern, but with a
// much shorter expiry (1 hour, set by the caller), since this grants
// direct account access rather than just an admission ticket.

async function createPasswordResetToken(userId, expiresAt) {
  const token = crypto.randomBytes(32).toString("hex");
  await db.query(`INSERT INTO password_reset_tokens (id, token, user_id, expires_at) VALUES ($1, $2, $3, $4)`, [
    crypto.randomUUID(),
    token,
    userId,
    expiresAt,
  ]);
  return token;
}

async function getPasswordResetTokenByUserId(userId) {
  // Not currently used outside this file -- kept for symmetry/debugging.
  const { rows } = await db.query(`SELECT * FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId]);
  return rows[0];
}

/**
 * The one atomic, race-safe single-use gate, exactly mirroring
 * markInviteRedeemed's shape -- only flips `used_at`, and only succeeds if
 * the token is real, unused, and unexpired at this exact instant. Returns
 * the associated userId on success, undefined otherwise.
 */
async function markPasswordResetTokenUsed(token) {
  const { rows } = await db.query(
    `UPDATE password_reset_tokens SET used_at = now()
     WHERE token = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [token]
  );
  return rows[0]?.user_id;
}

// ---------------------------------------------------------------------------
// Invites (routes/connect.js): lets an existing owner admit someone new --
// either a workspace "Sign in with Webflow" OAuth can never reach on its
// own (kind "environment", routes/environments.js) or a plain teammate
// directly into THIS SAME account (kind "team_member", routes/team.js).
// account_id's meaning depends on kind -- see db.js's table comment.

function inviteRowToObject(row) {
  return {
    id: row.id,
    token: row.token,
    accountId: row.account_id,
    kind: row.kind,
    createdByUserId: row.created_by_user_id,
    note: row.note,
    expiresAt: row.expires_at,
    failedAttempts: row.failed_attempts,
    redeemedAt: row.redeemed_at,
    redeemedByUserId: row.redeemed_by_user_id,
    redeemedAccountId: row.redeemed_account_id,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

// kind has no default -- every call site (routes/environments.js,
// routes/team.js) states explicitly which it means, rather than one
// silently inheriting the other's meaning.
async function createInvite(accountId, { kind, createdByUserId, note, expiresAt }) {
  const token = crypto.randomBytes(32).toString("hex");
  const { rows } = await db.query(
    `INSERT INTO invites (id, token, account_id, kind, created_by_user_id, note, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [crypto.randomUUID(), token, accountId, kind, createdByUserId || null, note || null, expiresAt]
  );
  return inviteRowToObject(rows[0]);
}

// kind is required, not optional -- without it, one account's "environment"
// and "team_member" invites (both entirely legitimate on the SAME account,
// e.g. the operator's own) would list together undifferentiated.
async function listInvites(accountId, kind) {
  const { rows } = await db.query(`SELECT * FROM invites WHERE account_id = $1 AND kind = $2 ORDER BY created_at DESC`, [
    accountId,
    kind,
  ]);
  return rows.map(inviteRowToObject);
}

async function getInviteByToken(token) {
  const { rows } = await db.query(`SELECT * FROM invites WHERE token = $1`, [token]);
  return rows[0] ? inviteRowToObject(rows[0]) : undefined;
}

const MAX_INVITE_FAILED_ATTEMPTS = 10;

// Same generic check both the redemption route's pre-check and its final
// atomic gate rely on -- kept in one place so "why is this invite dead"
// can never drift between the two call sites.
function isInviteValid(invite) {
  return (
    Boolean(invite) &&
    !invite.revokedAt &&
    !invite.redeemedAt &&
    new Date(invite.expiresAt) > new Date() &&
    invite.failedAttempts < MAX_INVITE_FAILED_ATTEMPTS
  );
}

async function incrementInviteFailedAttempts(id) {
  await db.query(`UPDATE invites SET failed_attempts = failed_attempts + 1 WHERE id = $1`, [id]);
}

/**
 * The one atomic, race-safe single-use gate -- only flips `redeemed_at`.
 * Deliberately does NOT set redeemed_by_user_id/redeemed_account_id here;
 * neither is known yet at this point in routes/connect.js's sequencing
 * (the Webflow token is validated and the invite is marked used BEFORE the
 * user/account are resolved, so a bad token never burns the invite -- see
 * that file). Returns undefined if the invite was invalid/already-redeemed/
 * expired/revoked/over the failed-attempts cap at this exact instant --
 * safe under concurrent redemption attempts against the same token, since
 * Postgres row locking on the UPDATE serializes them and only one can ever
 * see redeemed_at IS NULL and win.
 */
async function markInviteRedeemed(token) {
  const { rows } = await db.query(
    `UPDATE invites SET redeemed_at = now()
     WHERE token = $1 AND redeemed_at IS NULL AND revoked_at IS NULL
       AND expires_at > now() AND failed_attempts < $2
     RETURNING *`,
    [token, MAX_INVITE_FAILED_ATTEMPTS]
  );
  return rows[0] ? inviteRowToObject(rows[0]) : undefined;
}

// Bookkeeping only, called once the user/account are actually known --
// never part of the security-critical single-use gate above.
async function attributeInviteRedemption(id, { redeemedByUserId, redeemedAccountId }) {
  await db.query(`UPDATE invites SET redeemed_by_user_id = $2, redeemed_account_id = $3 WHERE id = $1`, [
    id,
    redeemedByUserId,
    redeemedAccountId,
  ]);
}

// Scoped by accountId so one account's owner can never revoke another
// account's invite given an arbitrary id (mirrors setAccountUserAccessLevel's
// same defensive scoping); scoped by kind too, for the same reason
// listInvites is. A no-op if it's already been redeemed.
async function revokeInvite(accountId, id, kind) {
  await db.query(
    `UPDATE invites SET revoked_at = now() WHERE id = $1 AND account_id = $2 AND kind = $3 AND redeemed_at IS NULL`,
    [id, accountId, kind]
  );
}

// ---------------------------------------------------------------------------
// Webflow connections (Phase 2: consumed by services/webflow.js's
// client()/siteId() for real per-account API access) -- either an OAuth
// grant (routes/auth.js) or a manually-pasted Site API token
// (routes/connect.js), stored identically; see upsertWebflowConnection.

async function upsertWebflowConnection(accountId, { webflowSiteId, accessTokenCiphertext, accessTokenIv, refreshTokenCiphertext, refreshTokenIv, scope, authorizationId, connectedByUserId }) {
  await db.query(
    `INSERT INTO webflow_connections
       (account_id, webflow_site_id, access_token_ciphertext, access_token_iv, refresh_token_ciphertext, refresh_token_iv, scope, authorization_id, connected_by_user_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')
     ON CONFLICT (account_id) DO UPDATE SET
       webflow_site_id = $2, access_token_ciphertext = $3, access_token_iv = $4,
       refresh_token_ciphertext = $5, refresh_token_iv = $6, scope = $7,
       authorization_id = $8, connected_by_user_id = $9, status = 'active', last_verified_at = now()`,
    [accountId, webflowSiteId, accessTokenCiphertext, accessTokenIv, refreshTokenCiphertext, refreshTokenIv, scope, authorizationId, connectedByUserId]
  );
}

/**
 * Decrypted { accessToken, webflowSiteId } for this account's own Webflow
 * OAuth grant, or `undefined` if it's never connected one (e.g. "Account
 * #1", migrated from this app's original single-tenant setup before
 * accounts existed at all -- see services/webflow.js's client()/siteId(),
 * which fall back to the static env-configured token for exactly this
 * case, so that pre-existing account keeps working unchanged).
 */
async function getWebflowConnection(accountId) {
  const { rows } = await db.query(`SELECT * FROM webflow_connections WHERE account_id = $1 AND status = 'active'`, [
    accountId,
  ]);
  if (!rows[0]) return undefined;
  const tokenCrypto = require("./services/tokenCrypto");
  const accessToken = tokenCrypto.decrypt(rows[0].access_token_ciphertext, rows[0].access_token_iv);
  return { accessToken, webflowSiteId: rows[0].webflow_site_id };
}

// ---------------------------------------------------------------------------
// wxrks credentials (Phase 3: consumed by services/wxrks.js's
// resolveConnection() for real per-account API access). No OAuth flow here
// -- these are entered manually via the Settings UI, so there's no login-
// time callback to populate this table automatically the way
// webflow_connections gets populated; see routes/settings.js's PUT/DELETE
// /wxrks-connection.

async function upsertWxrksConnection(accountId, { accessKey, secret, connectedByUserId }) {
  const tokenCrypto = require("./services/tokenCrypto");
  const { ciphertext: accessKeyCiphertext, iv: accessKeyIv } = tokenCrypto.encrypt(accessKey);
  const { ciphertext: secretCiphertext, iv: secretIv } = tokenCrypto.encrypt(secret);
  await db.query(
    `INSERT INTO wxrks_connections
       (account_id, access_key_ciphertext, access_key_iv, secret_ciphertext, secret_iv, connected_by_user_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     ON CONFLICT (account_id) DO UPDATE SET
       access_key_ciphertext = $2, access_key_iv = $3, secret_ciphertext = $4, secret_iv = $5,
       connected_by_user_id = $6, status = 'active', connected_at = now()`,
    [accountId, accessKeyCiphertext, accessKeyIv, secretCiphertext, secretIv, connectedByUserId]
  );
}

/**
 * Decrypted { accessKey, secret } for this account's own wxrks credentials,
 * or `undefined` if it's never connected any -- see services/wxrks.js's
 * resolveConnection(), which falls back to the static env-configured
 * credentials only for the one account that predates the accounts system
 * (checked via webflowSiteId === process.env.WEBFLOW_SITE_ID), and throws
 * for every other unconnected account instead of silently reusing them.
 */
async function getWxrksConnection(accountId) {
  const { rows } = await db.query(`SELECT * FROM wxrks_connections WHERE account_id = $1 AND status = 'active'`, [
    accountId,
  ]);
  if (!rows[0]) return undefined;
  const tokenCrypto = require("./services/tokenCrypto");
  const accessKey = tokenCrypto.decrypt(rows[0].access_key_ciphertext, rows[0].access_key_iv);
  const secret = tokenCrypto.decrypt(rows[0].secret_ciphertext, rows[0].secret_iv);
  return { accessKey, secret };
}

async function deleteWxrksConnection(accountId) {
  await db.query(`DELETE FROM wxrks_connections WHERE account_id = $1`, [accountId]);
}

// ---------------------------------------------------------------------------
// Optional per-account LLM connection (slugHandling's "transliterate"
// fallback for scripts the built-in map can't handle -- see
// services/transliterationLlm.js). Same shape/conventions as the wxrks
// connection above, just a single secret instead of a key/secret pair.

async function upsertLlmConnection(accountId, { apiKey, connectedByUserId }) {
  const tokenCrypto = require("./services/tokenCrypto");
  const { ciphertext: apiKeyCiphertext, iv: apiKeyIv } = tokenCrypto.encrypt(apiKey);
  await db.query(
    `INSERT INTO llm_connections (account_id, api_key_ciphertext, api_key_iv, connected_by_user_id, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (account_id) DO UPDATE SET
       api_key_ciphertext = $2, api_key_iv = $3, connected_by_user_id = $4, status = 'active', connected_at = now()`,
    [accountId, apiKeyCiphertext, apiKeyIv, connectedByUserId]
  );
}

async function getLlmConnection(accountId) {
  const { rows } = await db.query(`SELECT * FROM llm_connections WHERE account_id = $1 AND status = 'active'`, [
    accountId,
  ]);
  if (!rows[0]) return undefined;
  const tokenCrypto = require("./services/tokenCrypto");
  const apiKey = tokenCrypto.decrypt(rows[0].api_key_ciphertext, rows[0].api_key_iv);
  return { apiKey };
}

async function deleteLlmConnection(accountId) {
  await db.query(`DELETE FROM llm_connections WHERE account_id = $1`, [accountId]);
}

// ---------------------------------------------------------------------------
// Automations: a real table (not settings JSONB) since each automation's
// checkpoint/flush needs to read-modify-write independently without
// contending with other automations' or unrelated settings' concurrent
// writes -- the same reasoning that made project_mappings its own table.

// Best-effort one-way conversion of the old flush_times shape (a bare list
// of daily "HH:mm" times) into the new cadence shape, for rows created
// before cadence existed. A single time -> daily at that time; more than
// one -> approximated as hourly, evenly spaced from the earliest time
// (mirrors how those times were originally generated).
function flushTimesToCadence(flushTimes) {
  const times = [...(flushTimes || ["09:00"])].sort();
  if (times.length <= 1) return { kind: "daily", time: times[0] || "09:00" };
  const everyHours = Math.max(1, Math.round(24 / times.length));
  return { kind: "hourly", everyHours, startTime: times[0] };
}

function automationRowToObject(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    enabled: row.enabled,
    archived: row.archived,
    contentScope: row.content_scope,
    cadence: row.cadence || flushTimesToCadence(row.flush_times),
    workflows: row.workflows || ["TRANSLATION"],
    projectName: row.project_name || null,
    includeExisting: row.include_existing,
    orgUnitOverride: row.org_unit_override,
    targetLocalesOverride: row.target_locales_override,
    checkpoint: row.checkpoint,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function listAutomations(accountId) {
  const { rows } = await db.query(`SELECT * FROM automations WHERE account_id = $1 ORDER BY created_at ASC`, [
    accountId,
  ]);
  return rows.map(automationRowToObject);
}

async function getAutomation(accountId, id) {
  const { rows } = await db.query(`SELECT * FROM automations WHERE id = $1 AND account_id = $2`, [id, accountId]);
  return rows[0] ? automationRowToObject(rows[0]) : undefined;
}

/**
 * DANGER: bypasses account scoping entirely -- for the background job
 * machinery ONLY (autoSyncQueue.js's flush(), keyed by automation id since
 * its in-memory pending map predates any account concept and automation
 * ids are already globally unique app-generated UUIDs). Never call this
 * from a route handler or anywhere that takes an id from a client request;
 * every automation id reaching this must already have come from a
 * properly account-scoped read (listAutomations(accountId), or the pending
 * queue, itself only ever populated from such a read).
 */
async function getAutomationByIdUnscoped(id) {
  const { rows } = await db.query(`SELECT * FROM automations WHERE id = $1`, [id]);
  return rows[0] ? automationRowToObject(rows[0]) : undefined;
}

async function createAutomation(accountId, {
  id,
  name,
  enabled,
  contentScope,
  cadence,
  workflows,
  projectName,
  includeExisting,
  orgUnitOverride,
  targetLocalesOverride,
}) {
  const { rows } = await db.query(
    `INSERT INTO automations
       (id, account_id, name, enabled, content_scope, cadence, workflows, project_name, include_existing, org_unit_override, target_locales_override, checkpoint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}')
     RETURNING *`,
    [
      id || crypto.randomUUID(),
      accountId,
      name,
      enabled !== undefined ? enabled : true,
      JSON.stringify(contentScope),
      JSON.stringify(cadence || { kind: "daily", time: "09:00" }),
      JSON.stringify(workflows || ["TRANSLATION"]),
      projectName || null,
      includeExisting || false,
      orgUnitOverride || null,
      targetLocalesOverride ? JSON.stringify(targetLocalesOverride) : null,
    ]
  );
  return automationRowToObject(rows[0]);
}

const AUTOMATION_PATCH_COLUMNS = {
  name: "name",
  enabled: "enabled",
  archived: "archived",
  contentScope: "content_scope",
  cadence: "cadence",
  workflows: "workflows",
  projectName: "project_name",
  includeExisting: "include_existing",
  orgUnitOverride: "org_unit_override",
  targetLocalesOverride: "target_locales_override",
  checkpoint: "checkpoint",
};
const AUTOMATION_JSON_PATCH_KEYS = new Set(["contentScope", "cadence", "workflows", "checkpoint", "targetLocalesOverride"]);

async function updateAutomation(accountId, id, patch) {
  const keys = Object.keys(patch).filter((k) => AUTOMATION_PATCH_COLUMNS[k]);
  if (keys.length === 0) return getAutomation(accountId, id);

  const setClauses = keys.map((key, i) => `${AUTOMATION_PATCH_COLUMNS[key]} = $${i + 3}`);
  const values = keys.map((key) => (AUTOMATION_JSON_PATCH_KEYS.has(key) ? JSON.stringify(patch[key]) : patch[key]));

  const { rows } = await db.query(
    `UPDATE automations SET ${setClauses.join(", ")}, updated_at = now() WHERE id = $1 AND account_id = $2 RETURNING *`,
    [id, accountId, ...values]
  );
  return rows[0] ? automationRowToObject(rows[0]) : undefined;
}

async function deleteAutomation(accountId, id) {
  await db.query(`DELETE FROM automations WHERE id = $1 AND account_id = $2`, [id, accountId]);
}

/**
 * Whether one piece of content (a CMS item, a page, or "any component")
 * qualifies for this automation. Generalizes the old CMS-only
 * isAutomationCmsItemQualified into a leaf+filter model shared by all three
 * content kinds: Level 1 enabled -> Level 2 "all content" short-circuits
 * true, else the entity's leaf must be included in contentScope.leaves ->
 * Level 3 optional per-field conditions on that leaf (CMS collections
 * only -- Pages/Components leaves carry no filters, matching Webflow's
 * real data shape), via autoSyncRules.js's pure evaluateCondition.
 *
 * `entity` shapes by kind:
 *   collection: { leafId: collectionId, itemLike: {fieldData, isDraft, isArchived} }
 *   pagesFolder: { leafId: folderId }  -- pages carry no per-item draft/archived state
 *   components: {}  -- always all-or-nothing, no leafId
 */
function isAutomationContentQualified(automation, kind, entity) {
  if (!automation.enabled || automation.archived) return false;

  const { contentScope } = automation;
  if (contentScope.scope === "all") {
    if (kind === "collection" && (entity.itemLike.isDraft || entity.itemLike.isArchived)) return false;
    return true;
  }

  const leaf = (contentScope.leaves || []).find((l) => l.kind === kind && (kind === "components" || l.id === entity.leafId));
  if (!leaf) return false;

  if (kind === "collection") {
    if (entity.itemLike.isDraft || entity.itemLike.isArchived) return false;
    const conditions = leaf.filters || [];
    return conditions.every((cond) => evaluateCondition(cond, entity.itemLike));
  }

  return true;
}

function isAutomationItemAlreadySynced(automation, collectionId, itemId, lastPublishedIso) {
  const lastSyncedAt = automation.checkpoint.lastSyncedAt?.[collectionId]?.[itemId];
  if (!lastSyncedAt || !lastPublishedIso) return false;
  return new Date(lastPublishedIso) <= new Date(lastSyncedAt);
}

async function advanceAutomationCheckpoint(automation, isoTimestamp) {
  await updateAutomation(automation.accountId, automation.id, { checkpoint: { ...automation.checkpoint, lastCheckpoint: isoTimestamp } });
}

function createSyncJob(job) {
  syncJobs.set(job.id, {
    id: job.id,
    mode: job.mode,
    total: job.total,
    wxrksProjectUUID: job.wxrksProjectUUID,
    orgUnitUUID: job.orgUnitUUID,
    targetLocales: job.targetLocales || [],
    processed: 0,
    results: [],
    status: "running",
    cancelled: false,
    startedAt: new Date().toISOString(),
    // True only for an automation's first-run job between being created and
    // the scan finishing (see automationScheduler.js's startFirstSyncJob) --
    // `total`/`processed` aren't meaningful counts yet at that point, so the
    // client shows an indeterminate "Scanning..." state instead of a
    // fraction while this is true.
    scanning: job.scanning || false,
  });
  return syncJobs.get(job.id);
}

function getSyncJob(jobId) {
  return syncJobs.get(jobId);
}

function updateSyncJob(jobId, patch) {
  const existing = syncJobs.get(jobId);
  if (!existing) return undefined;
  const updated = { ...existing, ...patch };
  syncJobs.set(jobId, updated);
  return updated;
}

function appendSyncJobResult(jobId, result) {
  const existing = syncJobs.get(jobId);
  if (!existing) return undefined;
  return updateSyncJob(jobId, {
    processed: existing.processed + 1,
    results: [...existing.results, result],
  });
}

function cancelSyncJob(jobId) {
  return updateSyncJob(jobId, { cancelled: true });
}

async function setLastSync(accountId, record) {
  const value = { ...record, timestamp: new Date().toISOString() };
  await db.query(
    `INSERT INTO app_state (account_id, key, value) VALUES ($1, 'lastSync', $2)
     ON CONFLICT (account_id, key) DO UPDATE SET value = $2`,
    [accountId, JSON.stringify(value)]
  );
  return value;
}

async function getLastSync(accountId) {
  const { rows } = await db.query(`SELECT value FROM app_state WHERE account_id = $1 AND key = 'lastSync'`, [
    accountId,
  ]);
  return rows[0] ? rows[0].value : null;
}

// TEMPORARY: captures the raw payloads of recent incoming wxrks webhook
// calls, for inspecting real event shapes. Keeps a ring buffer (not just the
// last one) since validation pings sent when adding a new webhook were
// overwriting real events we hadn't looked at yet. Remove once done.
const DEBUG_WEBHOOK_HISTORY_LIMIT = 20;

async function setDebugWebhookPayload(accountId, payload) {
  const entry = { ...payload, receivedAt: new Date().toISOString() };
  const { rows } = await db.query(`SELECT value FROM app_state WHERE account_id = $1 AND key = 'debugWebhookHistory'`, [
    accountId,
  ]);
  const history = rows[0] ? rows[0].value : [];
  const updated = [entry, ...history].slice(0, DEBUG_WEBHOOK_HISTORY_LIMIT);
  await db.query(
    `INSERT INTO app_state (account_id, key, value) VALUES ($1, 'debugWebhookHistory', $2)
     ON CONFLICT (account_id, key) DO UPDATE SET value = $2`,
    [accountId, JSON.stringify(updated)]
  );
  return entry;
}

async function getDebugWebhookPayload(accountId) {
  const { rows } = await db.query(`SELECT value FROM app_state WHERE account_id = $1 AND key = 'debugWebhookHistory'`, [
    accountId,
  ]);
  return rows[0] ? rows[0].value : [];
}

module.exports = {
  createProjectMapping,
  addItemToProjectMapping,
  addWebflowUpdateToProjectMapping,
  getProjectMapping,
  updateProjectMapping,
  listProjectMappings,
  listActiveProjects,
  getDeliveryStatusByEntity,
  latestUpdateByEntityAndLocale,
  computeLocaleStatus,
  getSettings,
  updateSettings,
  getFieldExclusions,
  setFieldExclusions,
  getComponentPropertyExclusions,
  setComponentPropertyExclusions,
  updateAutoSyncWebhookState,
  updateSitePublishWebhookState,
  updateWxrksWebhookState,
  getAccountByWebflowSiteId,
  getAccount,
  createAccount,
  listAllAccounts,
  getUserByWebflowUserId,
  upsertUser,
  getUserForLogin,
  setUserPassword,
  upsertAccountMembership,
  listAccountsForUser,
  listAccountMembers,
  setAccountUserAccessLevel,
  recordActivity,
  listActivity,
  createSession,
  getSessionWithUserAndAccount,
  touchSession,
  deleteSession,
  deleteSessionsForUser,
  createPasswordResetToken,
  getPasswordResetTokenByUserId,
  markPasswordResetTokenUsed,
  createInvite,
  listInvites,
  getInviteByToken,
  isInviteValid,
  incrementInviteFailedAttempts,
  markInviteRedeemed,
  attributeInviteRedemption,
  revokeInvite,
  upsertWebflowConnection,
  getWebflowConnection,
  upsertWxrksConnection,
  getWxrksConnection,
  deleteWxrksConnection,
  upsertLlmConnection,
  getLlmConnection,
  deleteLlmConnection,
  listAutomations,
  getAutomation,
  getAutomationByIdUnscoped,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  isAutomationContentQualified,
  isAutomationItemAlreadySynced,
  advanceAutomationCheckpoint,
  setLastSync,
  getLastSync,
  setDebugWebhookPayload,
  getDebugWebhookPayload,
  createSyncJob,
  getSyncJob,
  updateSyncJob,
  appendSyncJobResult,
  cancelSyncJob,
};
