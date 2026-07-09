const crypto = require("crypto");
const express = require("express");
const webflow = require("../services/webflow");
const wxrks = require("../services/wxrks");
const store = require("../store");
const { syncItemIntoBatch, requestBatchApproval } = require("../services/syncCore");

const router = express.Router();

/**
 * POST /api/sync/item
 * body: { collectionId, itemId } or { collectionId, itemIds: [...] }
 * Syncs one or more Webflow CMS items (from the same collection) into a
 * single wxrks project. Creates the project synchronously (fast), then
 * processes items in the background and returns a jobId to poll -- a large
 * selection (e.g. a whole collection, or "All content") can mean hundreds
 * of real wxrks API calls and take minutes, far too long to hold an HTTP
 * request open for. Mirrors the old Bulk Sync job pattern, generalized to
 * any one-time send regardless of size.
 */
router.post("/item", async (req, res) => {
  const {
    collectionId,
    itemId,
    itemIds,
    workflows,
    projectName,
    orgUnitUUID: orgUnitUUIDOverride,
    targetLocales: targetLocalesOverride,
  } = req.body || {};
  const ids = itemIds && itemIds.length > 0 ? itemIds : itemId ? [itemId] : [];

  const accountId = req.account.id;
  try {
    const {
      sourceLocale,
      targetLocales: settingsTargetLocales,
      orgUnitUUID: settingsOrgUnitUUID,
      autoApprove,
      workUnitNamePattern,
    } = await store.getSettings(accountId);
    // The wizard's Settings step lets a user pick a different org unit/set of
    // target locales for this specific send -- honor that instead of always
    // falling back to the account's stored defaults.
    const targetLocales = targetLocalesOverride?.length ? targetLocalesOverride : settingsTargetLocales;

    if (!collectionId || ids.length === 0) {
      return res.status(400).json({ error: "collectionId and at least one itemId are required" });
    }
    if (targetLocales.length === 0) {
      return res.status(400).json({ error: "No target locales configured. Set them in Settings first." });
    }

    const orgUnitUUID = orgUnitUUIDOverride || settingsOrgUnitUUID || (await wxrks.getOrgUnit());
    const collection = await webflow.getCollection(collectionId);

    const project = await wxrks.createProject({
      reference: projectName || `Item Sync / ${collection.displayName || collectionId} / ${new Date().toISOString()}`,
      sourceLocale,
      orgUnitUUID,
    });
    await store.createProjectMapping(accountId, project.uuid, {
      mode: "item",
      sourceLocale,
      targetLocales,
      orgUnitUUID,
      workUnitNamePattern,
      status: "in_progress",
      wxrksStatus: "DRAFT",
    });

    const jobId = crypto.randomUUID();
    store.createSyncJob({ id: jobId, mode: "item", total: ids.length, wxrksProjectUUID: project.uuid, orgUnitUUID, targetLocales });

    res.json({ jobId, total: ids.length, wxrksProjectUUID: project.uuid, orgUnitUUID, targetLocales });

    // Runs after the response is sent -- this request has already returned.
    (async () => {
      for (const id of ids) {
        if (store.getSyncJob(jobId).cancelled) break;

        try {
          const item = await webflow.getItem(collectionId, id, { locale: sourceLocale });
          const result = await syncItemIntoBatch({
            accountId,
            projectUuid: project.uuid,
            collection,
            item,
            targetLocales,
            namePattern: workUnitNamePattern,
            workflows,
          });
          store.appendSyncJobResult(jobId, { itemId: id, ...result });
        } catch (err) {
          store.appendSyncJobResult(jobId, { itemId: id, error: err.message });
        }
      }

      const finalJob = store.getSyncJob(jobId);
      const itemsSynced = finalJob.results.filter((r) => !r.skipped && !r.error).length;
      const summary = {
        itemsProcessed: finalJob.processed,
        itemsSynced,
        skipped: finalJob.results.filter((r) => r.skipped).length,
        errors: finalJob.results.filter((r) => r.error).length,
        estimatedWordCount: finalJob.results.reduce((sum, r) => sum + (r.wordCount || 0), 0),
        wxrksProjectUUID: project.uuid,
        orgUnitUUID,
        targetLocales,
      };
      store.updateSyncJob(jobId, { status: finalJob.cancelled ? "cancelled" : "completed" });
      await store.setLastSync(accountId, { mode: "item", summary });

      if (autoApprove && itemsSynced > 0) {
        requestBatchApproval(project.uuid);
      }
    })().catch((err) => {
      console.error(`Item sync job ${jobId} crashed:`, err.message);
      store.updateSyncJob(jobId, { status: "error", error: err.message });
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/sync/jobs/:jobId
 * POST /api/sync/jobs/:jobId/cancel
 * Shared job polling/cancel endpoints for every one-time send (CMS item,
 * pages item, components item) -- store.js's job tracking is keyed purely
 * by jobId (a random uuid), not scoped to which route created it, so one
 * pair of endpoints covers all three kinds.
 */
router.get("/jobs/:jobId", (req, res) => {
  const job = store.getSyncJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

router.post("/jobs/:jobId/cancel", (req, res) => {
  const job = store.cancelSyncJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

/**
 * GET /api/sync/status
 * Last sync summary + currently in-progress wxrks projects, for the Dashboard.
 */
router.get("/status", async (req, res) => {
  try {
    const [lastSync, activeProjects] = await Promise.all([
      store.getLastSync(req.account.id),
      store.listActiveProjects(req.account.id),
    ]);
    res.json({ lastSync, activeProjects });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/sync/history
 * Every batch ever created (not just active ones), most recent first --
 * each entry carries the full settings snapshot (org unit, locales,
 * collections, naming pattern) that produced its wxrks project.
 */
router.get("/history", async (req, res) => {
  try {
    const history = await store.listProjectMappings(req.account.id);
    res.json({ history });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
