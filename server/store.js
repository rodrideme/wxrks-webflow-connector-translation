/**
 * Persisted state (settings, sync history) lives in Postgres via db.js, so it
 * survives process restarts and Render deploys. Sync-job progress tracking
 * stays in-memory: it's only meaningful for the lifetime of the background
 * loop driving it in this process anyway -- a restart kills that loop
 * regardless of where its progress was recorded.
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
  orgUnitUUID: process.env.WXRKS_ORG_UNIT_UUID || "",
  // Explicit flag rather than "empty enabledCollectionIds means all" -- that
  // convention couldn't represent "user unchecked every collection", so
  // "check all" / "uncheck all" need a real on/off switch instead of relying
  // on array emptiness.
  allCollectionsEnabled: true,
  enabledCollectionIds: [],
  // { [collectionId]: string[] of field slugs to never translate, on top of
  // the automatic type-based filter }
  fieldExclusions: {},
  // Placeholders: {collection}, {entry}. Becomes the wxrks resource/work-
  // unit file name (wxrks has no separate "name" field -- it derives the
  // work unit name from the uploaded file name).
  workUnitNamePattern: DEFAULT_WORK_UNIT_NAME_PATTERN,
  // Static Pages manual Select & Send scope (separate from Automation's
  // per-automation `content_scope.pageFolderIds`). Mirrors the CMS
  // collection enable-tree shape (allCollectionsEnabled/enabledCollectionIds)
  // but is entirely separate, since pages have no field schema and a
  // different Webflow API surface (DOM node tree, not fieldData).
  pages: {
    allPagesEnabled: true,
    enabledPageIds: [],
  },
  // Placeholder: {page}. Kept separate from workUnitNamePattern since the
  // token vocabulary differs (a page has no collection/entry distinction).
  pagesWorkUnitNamePattern: DEFAULT_PAGE_WORK_UNIT_NAME_PATTERN,
  // Components manual Select & Send scope, same reasoning as Pages above.
  components: {
    allComponentsEnabled: true,
    enabledComponentIds: [],
  },
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
};

// jobId -> { id, mode, total, processed, results: [], status, cancelled, startedAt }
const syncJobs = new Map();

function mappingRowToObject(row) {
  return {
    wxrksProjectUUID: row.wxrks_project_uuid,
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
  };
}

async function createProjectMapping(wxrksProjectUUID, mapping) {
  const { rows } = await db.query(
    `INSERT INTO project_mappings
       (wxrks_project_uuid, mode, source_locale, target_locales, org_unit_uuid,
        work_unit_name_pattern, collection_ids, items, status, wxrks_status, automation_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      wxrksProjectUUID,
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
    ]
  );
  return mappingRowToObject(rows[0]);
}

/**
 * Appends one Webflow item's resource to an existing batch mapping and
 * tracks its collection in `collectionIds`. Used to build up the mapping
 * incrementally as a bulk/batch sync processes each item, so a mid-run
 * cancellation still leaves an accurate record of what was actually synced.
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

async function listProjectMappings() {
  const { rows } = await db.query(`SELECT * FROM project_mappings ORDER BY created_at DESC`);
  return rows.map(mappingRowToObject);
}

async function listActiveProjects() {
  const { rows } = await db.query(
    `SELECT * FROM project_mappings WHERE status = 'in_progress' ORDER BY created_at DESC`
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
async function getDeliveryStatusByEntity(idField) {
  const mappings = await listProjectMappings();
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
  merged.pages = {
    ...DEFAULT_SETTINGS.pages,
    ...(stored.pages || {}),
  };
  merged.components = {
    ...DEFAULT_SETTINGS.components,
    ...(stored.components || {}),
  };
  return merged;
}

async function getSettings() {
  const { rows } = await db.query(`SELECT value FROM app_state WHERE key = 'settings'`);
  // Merge over defaults so a settings field added after a row was first
  // written (e.g. allCollectionsEnabled) still gets a sane value instead of
  // undefined for existing installs.
  if (rows[0]) return mergeSettings(rows[0].value);

  await db.query(`INSERT INTO app_state (key, value) VALUES ('settings', $1) ON CONFLICT (key) DO NOTHING`, [
    JSON.stringify(DEFAULT_SETTINGS),
  ]);
  return DEFAULT_SETTINGS;
}

async function updateSettings(patch) {
  const current = await getSettings();
  const updated = { ...current, ...patch };
  await db.query(
    `INSERT INTO app_state (key, value) VALUES ('settings', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(updated)]
  );
  return updated;
}

// Pure helper -- no DB access. Callers fetch settings once via getSettings()
// and reuse it across a loop, rather than hitting the DB per collection.
function isCollectionEnabled(settings, collectionId) {
  return settings.allCollectionsEnabled || settings.enabledCollectionIds.includes(collectionId);
}

// Pure helper, mirrors isCollectionEnabled but for static pages.
function isPageEnabled(settings, pageId) {
  return settings.pages.allPagesEnabled || settings.pages.enabledPageIds.includes(pageId);
}

// Pure helper, mirrors isPageEnabled but for components.
function isComponentEnabled(settings, componentId) {
  return settings.components.allComponentsEnabled || settings.components.enabledComponentIds.includes(componentId);
}

async function getFieldExclusions(collectionId) {
  const settings = await getSettings();
  return settings.fieldExclusions[collectionId] || [];
}

async function setFieldExclusions(collectionId, excludedFields) {
  const settings = await getSettings();
  const fieldExclusions = { ...settings.fieldExclusions, [collectionId]: excludedFields };
  await updateSettings({ fieldExclusions });
  return excludedFields;
}

/**
 * Read-modify-write onto the freshly-read current settings, used only by
 * server-side webhook lifecycle code (registration, reconciliation's
 * deactivation inference) -- kept separate from the general updateSettings()
 * PUT path so a client Settings save racing a server-side webhook-status
 * update can't clobber it.
 */
async function updateAutoSyncWebhookState(patch) {
  const settings = await getSettings();
  const autoSyncWebhook = { ...settings.autoSyncWebhook, ...patch };
  await updateSettings({ autoSyncWebhook });
  return autoSyncWebhook;
}

async function updateSitePublishWebhookState(patch) {
  const settings = await getSettings();
  const sitePublishWebhook = { ...settings.sitePublishWebhook, ...patch };
  await updateSettings({ sitePublishWebhook });
  return sitePublishWebhook;
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
    name: row.name,
    enabled: row.enabled,
    archived: row.archived,
    contentScope: row.content_scope,
    cadence: row.cadence || flushTimesToCadence(row.flush_times),
    workflows: row.workflows || ["TRANSLATION"],
    projectName: row.project_name || null,
    includeExisting: row.include_existing,
    orgUnitOverride: row.org_unit_override,
    checkpoint: row.checkpoint,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function listAutomations() {
  const { rows } = await db.query(`SELECT * FROM automations ORDER BY created_at ASC`);
  return rows.map(automationRowToObject);
}

async function getAutomation(id) {
  const { rows } = await db.query(`SELECT * FROM automations WHERE id = $1`, [id]);
  return rows[0] ? automationRowToObject(rows[0]) : undefined;
}

async function createAutomation({
  id,
  name,
  enabled,
  contentScope,
  cadence,
  workflows,
  projectName,
  includeExisting,
  orgUnitOverride,
}) {
  const { rows } = await db.query(
    `INSERT INTO automations
       (id, name, enabled, content_scope, cadence, workflows, project_name, include_existing, org_unit_override, checkpoint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}')
     RETURNING *`,
    [
      id || crypto.randomUUID(),
      name,
      enabled !== undefined ? enabled : true,
      JSON.stringify(contentScope),
      JSON.stringify(cadence || { kind: "daily", time: "09:00" }),
      JSON.stringify(workflows || ["TRANSLATION"]),
      projectName || null,
      includeExisting || false,
      orgUnitOverride || null,
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
  checkpoint: "checkpoint",
};
const AUTOMATION_JSON_PATCH_KEYS = new Set(["contentScope", "cadence", "workflows", "checkpoint"]);

async function updateAutomation(id, patch) {
  const keys = Object.keys(patch).filter((k) => AUTOMATION_PATCH_COLUMNS[k]);
  if (keys.length === 0) return getAutomation(id);

  const setClauses = keys.map((key, i) => `${AUTOMATION_PATCH_COLUMNS[key]} = $${i + 2}`);
  const values = keys.map((key) => (AUTOMATION_JSON_PATCH_KEYS.has(key) ? JSON.stringify(patch[key]) : patch[key]));

  const { rows } = await db.query(
    `UPDATE automations SET ${setClauses.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0] ? automationRowToObject(rows[0]) : undefined;
}

async function deleteAutomation(id) {
  await db.query(`DELETE FROM automations WHERE id = $1`, [id]);
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
    return conditions.every((cond) => evaluateCondition(cond, entity.itemLike.fieldData));
  }

  return true;
}

function isAutomationItemAlreadySynced(automation, collectionId, itemId, lastPublishedIso) {
  const lastSyncedAt = automation.checkpoint.lastSyncedAt?.[collectionId]?.[itemId];
  if (!lastSyncedAt || !lastPublishedIso) return false;
  return new Date(lastPublishedIso) <= new Date(lastSyncedAt);
}

async function markAutomationItemSynced(automationId, collectionId, itemId, lastPublishedIso) {
  const automation = await getAutomation(automationId);
  if (!automation) return;
  const lastSyncedAt = {
    ...automation.checkpoint.lastSyncedAt,
    [collectionId]: { ...(automation.checkpoint.lastSyncedAt?.[collectionId] || {}), [itemId]: lastPublishedIso },
  };
  await updateAutomation(automationId, { checkpoint: { ...automation.checkpoint, lastSyncedAt } });
}

// Content-hash based, like Components below -- NOT a lastUpdated timestamp
// comparison. Confirmed live: a full "Publish site" action in Webflow bumps
// every page's lastUpdated regardless of whether that specific page's
// translatable content actually changed, which was flooding the pending
// queue with the entire site after any full-site publish. Hashing what's
// actually translatable is immune to that.
function isAutomationPageAlreadySynced(automation, pageId, contentHash) {
  const lastHash = automation.checkpoint.lastSyncedPageHashes?.[pageId];
  return lastHash === contentHash;
}

async function markAutomationPageSynced(automationId, pageId, contentHash) {
  const automation = await getAutomation(automationId);
  if (!automation) return;
  const lastSyncedPageHashes = { ...automation.checkpoint.lastSyncedPageHashes, [pageId]: contentHash };
  await updateAutomation(automationId, { checkpoint: { ...automation.checkpoint, lastSyncedPageHashes } });
}

// Components carry no modification timestamp at all (confirmed live against
// the real Webflow API), so dedup compares a content hash instead of a date.
function isAutomationComponentAlreadySynced(automation, componentId, contentHash) {
  const lastHash = automation.checkpoint.lastSyncedComponentHashes?.[componentId];
  return lastHash === contentHash;
}

async function markAutomationComponentSynced(automationId, componentId, contentHash) {
  const automation = await getAutomation(automationId);
  if (!automation) return;
  const lastSyncedComponentHashes = { ...automation.checkpoint.lastSyncedComponentHashes, [componentId]: contentHash };
  await updateAutomation(automationId, { checkpoint: { ...automation.checkpoint, lastSyncedComponentHashes } });
}

async function advanceAutomationCheckpoint(automationId, isoTimestamp) {
  const automation = await getAutomation(automationId);
  if (!automation) return;
  await updateAutomation(automationId, { checkpoint: { ...automation.checkpoint, lastCheckpoint: isoTimestamp } });
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

async function setLastSync(record) {
  const value = { ...record, timestamp: new Date().toISOString() };
  await db.query(
    `INSERT INTO app_state (key, value) VALUES ('lastSync', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(value)]
  );
  return value;
}

async function getLastSync() {
  const { rows } = await db.query(`SELECT value FROM app_state WHERE key = 'lastSync'`);
  return rows[0] ? rows[0].value : null;
}

// TEMPORARY: captures the raw payloads of recent incoming wxrks webhook
// calls, for inspecting real event shapes. Keeps a ring buffer (not just the
// last one) since validation pings sent when adding a new webhook were
// overwriting real events we hadn't looked at yet. Remove once done.
const DEBUG_WEBHOOK_HISTORY_LIMIT = 20;

async function setDebugWebhookPayload(payload) {
  const entry = { ...payload, receivedAt: new Date().toISOString() };
  const { rows } = await db.query(`SELECT value FROM app_state WHERE key = 'debugWebhookHistory'`);
  const history = rows[0] ? rows[0].value : [];
  const updated = [entry, ...history].slice(0, DEBUG_WEBHOOK_HISTORY_LIMIT);
  await db.query(
    `INSERT INTO app_state (key, value) VALUES ('debugWebhookHistory', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(updated)]
  );
  return entry;
}

async function getDebugWebhookPayload() {
  const { rows } = await db.query(`SELECT value FROM app_state WHERE key = 'debugWebhookHistory'`);
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
  computeLocaleStatus,
  getSettings,
  updateSettings,
  isCollectionEnabled,
  isPageEnabled,
  isComponentEnabled,
  getFieldExclusions,
  setFieldExclusions,
  updateAutoSyncWebhookState,
  updateSitePublishWebhookState,
  listAutomations,
  getAutomation,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  isAutomationContentQualified,
  isAutomationItemAlreadySynced,
  markAutomationItemSynced,
  isAutomationPageAlreadySynced,
  markAutomationPageSynced,
  isAutomationComponentAlreadySynced,
  markAutomationComponentSynced,
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
