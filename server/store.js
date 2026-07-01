/**
 * Persisted state (settings, sync history) lives in Postgres via db.js, so it
 * survives process restarts and Render deploys. Sync-job progress tracking
 * stays in-memory: it's only meaningful for the lifetime of the background
 * loop driving it in this process anyway -- a restart kills that loop
 * regardless of where its progress was recorded.
 */

const db = require("./db");
const { DEFAULT_WORK_UNIT_NAME_PATTERN } = require("./services/webflow");

const DEFAULT_SETTINGS = {
  sourceLocale: process.env.SOURCE_LOCALE || "en",
  targetLocales: [],
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
  };
}

async function createProjectMapping(wxrksProjectUUID, mapping) {
  const { rows } = await db.query(
    `INSERT INTO project_mappings
       (wxrks_project_uuid, mode, source_locale, target_locales, org_unit_uuid,
        work_unit_name_pattern, collection_ids, items, status, wxrks_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      wxrksProjectUUID,
      mapping.mode || "bulk",
      mapping.sourceLocale,
      JSON.stringify(mapping.targetLocales || []),
      mapping.orgUnitUUID,
      mapping.workUnitNamePattern,
      JSON.stringify(mapping.collectionIds || []),
      JSON.stringify(mapping.items || []),
      mapping.status || "in_progress",
      mapping.wxrksStatus || "DRAFT",
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
  { webflowCollectionId, webflowItemId, resourceId, resourceFileName, fieldKeys, wordCount }
) {
  const existing = await getProjectMapping(wxrksProjectUUID);
  if (!existing) return undefined;

  const collectionIds = existing.collectionIds.includes(webflowCollectionId)
    ? existing.collectionIds
    : [...existing.collectionIds, webflowCollectionId];

  return updateProjectMapping(wxrksProjectUUID, {
    collectionIds,
    items: [
      ...existing.items,
      { webflowCollectionId, webflowItemId, resourceId, resourceFileName, fieldKeys, wordCount },
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

async function getSettings() {
  const { rows } = await db.query(`SELECT value FROM app_state WHERE key = 'settings'`);
  // Merge over defaults so a settings field added after a row was first
  // written (e.g. allCollectionsEnabled) still gets a sane value instead of
  // undefined for existing installs.
  if (rows[0]) return { ...DEFAULT_SETTINGS, ...rows[0].value };

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
  getSettings,
  updateSettings,
  isCollectionEnabled,
  getFieldExclusions,
  setFieldExclusions,
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
