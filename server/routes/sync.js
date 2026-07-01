const crypto = require("crypto");
const express = require("express");
const webflow = require("../services/webflow");
const wxrks = require("../services/wxrks");
const store = require("../store");

const router = express.Router();

/**
 * Adds one Webflow item to an *already-created* wxrks project as a single
 * resource (all its translatable fields bundled into one JSON file) + one
 * work unit, and records it in that project's batch mapping. A whole sync
 * run (Full Sync or a multi-item Item Sync selection) shares a single wxrks
 * project rather than creating one project per item, and each item gets
 * exactly one work unit rather than one per field.
 */
async function syncItemIntoBatch({ projectUuid, collection, item, targetLocales, namePattern }) {
  const fieldTypeBySlug = webflow.getFieldTypeMap(collection);
  const exclusions = await store.getFieldExclusions(collection.id);
  const translatableFields = webflow.filterTranslatableFields(item.fieldData, fieldTypeBySlug, exclusions);

  if (Object.keys(translatableFields).length === 0) {
    return { skipped: true, reason: "no translatable fields" };
  }

  const filename = webflow.buildResourceFileName(namePattern, { collection, item });
  const resource = await wxrks.createResource(projectUuid, { name: filename });
  const fileContent = Buffer.from(JSON.stringify(translatableFields), "utf-8");
  await wxrks.uploadResourceContent(projectUuid, resource.resourceId, fileContent, filename);

  await wxrks.createWorkUnitsBulk(projectUuid, [{ resourceId: resource.resourceId, targetLocales }]);

  const fieldKeys = Object.keys(translatableFields);
  const wordCount = webflow.countWords(translatableFields);

  await store.addItemToProjectMapping(projectUuid, {
    webflowCollectionId: collection.id,
    webflowItemId: item.id,
    resourceId: resource.resourceId,
    fieldKeys,
    wordCount,
  });

  return { skipped: false, fieldsCount: fieldKeys.length, wordCount };
}

/**
 * Kicks off auto-approval for a whole batch project once, after every item
 * in it has been synced -- not per item. Runs in the background: polling
 * for wxrks's async status propagation can take up to ~45s per phase, far
 * too long to hold a sync request (or a batch loop) open for.
 */
function requestBatchApproval(projectUuid) {
  wxrks
    .approveProject(projectUuid)
    .then((wxrksStatus) => store.updateProjectMapping(projectUuid, { wxrksStatus }))
    .catch((err) => console.error(`Auto-approve failed for wxrks project ${projectUuid}:`, err.message));
}

/**
 * Resolves which (collection, item) pairs a bulk sync would touch, without
 * changing anything. Shared by the dry-run preview and the real run so the
 * two can never disagree on scope.
 */
async function planBulkSync({ sourceLocale, translateFromDate, settings }) {
  const allCollections = await webflow.listCollections();
  const collections = allCollections.filter((c) => store.isCollectionEnabled(settings, c.id));
  const cutoff = translateFromDate ? new Date(translateFromDate) : null;

  const plan = [];
  for (const collection of collections) {
    const items = await webflow.listAllItems(collection.id, { locale: sourceLocale });
    const eligible = cutoff ? items.filter((it) => new Date(it.lastUpdated) >= cutoff) : items;
    for (const item of eligible) {
      plan.push({ collection, item });
    }
  }
  return plan;
}

/**
 * POST /api/sync/bulk
 * body: { translateFromDate?: ISO date string, dryRun?: boolean }
 * dryRun: true just returns counts (no side effects) for a preview before
 * committing to a real run.
 * Otherwise creates a single wxrks project for the whole run, starts a
 * background job, and returns immediately with a jobId to poll -- a
 * full-site sync can touch hundreds of items and take minutes, far too long
 * to hold an HTTP request (or a user) open for.
 */
router.post("/bulk", async (req, res) => {
  const { translateFromDate, dryRun } = req.body || {};

  try {
    const settings = await store.getSettings();
    const { sourceLocale, targetLocales, orgUnitUUID: settingsOrgUnitUUID, autoApprove, workUnitNamePattern } =
      settings;

    if (targetLocales.length === 0) {
      return res.status(400).json({ error: "No target locales configured. Set them in Settings first." });
    }

    const plan = await planBulkSync({ sourceLocale, translateFromDate, settings });

    if (dryRun) {
      const byCollection = {};
      let estimatedWordCount = 0;
      for (const { collection, item } of plan) {
        const name = collection.displayName || collection.id;
        byCollection[name] = (byCollection[name] || 0) + 1;

        // listAllItems already returned full fieldData, so this costs nothing
        // extra -- no additional Webflow calls needed for the preview.
        const fieldTypeBySlug = webflow.getFieldTypeMap(collection);
        const exclusions = await store.getFieldExclusions(collection.id);
        const translatableFields = webflow.filterTranslatableFields(item.fieldData, fieldTypeBySlug, exclusions);
        estimatedWordCount += webflow.countWords(translatableFields);
      }
      return res.json({ totalItems: plan.length, byCollection, estimatedWordCount });
    }

    if (plan.length === 0) {
      await store.setLastSync({ mode: "bulk", summary: { itemsProcessed: 0, itemsSynced: 0 } });
      return res.json({ total: 0, message: "No items matched the current filter." });
    }

    const orgUnitUUID = settingsOrgUnitUUID || (await wxrks.getOrgUnit());
    const project = await wxrks.createProject({
      reference: `Full Sync ${new Date().toISOString()}`,
      sourceLocale,
      orgUnitUUID,
    });
    await store.createProjectMapping(project.uuid, {
      mode: "bulk",
      sourceLocale,
      targetLocales,
      orgUnitUUID,
      workUnitNamePattern,
      status: "in_progress",
      wxrksStatus: "DRAFT",
    });

    const jobId = crypto.randomUUID();
    store.createSyncJob({
      id: jobId,
      mode: "bulk",
      total: plan.length,
      wxrksProjectUUID: project.uuid,
      orgUnitUUID,
      targetLocales,
    });

    res.json({ jobId, total: plan.length, wxrksProjectUUID: project.uuid, orgUnitUUID, targetLocales });

    // Runs after the response is sent -- this request has already returned.
    (async () => {
      for (const { collection, item } of plan) {
        if (store.getSyncJob(jobId).cancelled) break;

        try {
          const result = await syncItemIntoBatch({
            projectUuid: project.uuid,
            collection,
            item,
            targetLocales,
            namePattern: workUnitNamePattern,
          });
          store.appendSyncJobResult(jobId, { collectionId: collection.id, itemId: item.id, ...result });
        } catch (err) {
          store.appendSyncJobResult(jobId, { collectionId: collection.id, itemId: item.id, error: err.message });
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
      await store.setLastSync({ mode: "bulk", summary });

      if (autoApprove && itemsSynced > 0) {
        requestBatchApproval(project.uuid);
      }
    })().catch((err) => {
      console.error(`Bulk sync job ${jobId} crashed:`, err.message);
      store.updateSyncJob(jobId, { status: "error", error: err.message });
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/sync/bulk/:jobId
 * Poll for progress on a background bulk sync job.
 */
router.get("/bulk/:jobId", (req, res) => {
  const job = store.getSyncJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

/**
 * POST /api/sync/bulk/:jobId/cancel
 * Stops the job before its next item -- items already in flight still finish.
 */
router.post("/bulk/:jobId/cancel", (req, res) => {
  const job = store.cancelSyncJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

/**
 * POST /api/sync/item
 * body: { collectionId, itemId } or { collectionId, itemIds: [...] }
 * Syncs one or more Webflow CMS items (from the same collection) into a
 * single wxrks project.
 */
router.post("/item", async (req, res) => {
  const { collectionId, itemId, itemIds } = req.body || {};
  const ids = itemIds && itemIds.length > 0 ? itemIds : itemId ? [itemId] : [];

  try {
    const {
      sourceLocale,
      targetLocales,
      orgUnitUUID: settingsOrgUnitUUID,
      autoApprove,
      workUnitNamePattern,
    } = await store.getSettings();

    if (!collectionId || ids.length === 0) {
      return res.status(400).json({ error: "collectionId and at least one itemId are required" });
    }
    if (targetLocales.length === 0) {
      return res.status(400).json({ error: "No target locales configured. Set them in Settings first." });
    }

    const orgUnitUUID = settingsOrgUnitUUID || (await wxrks.getOrgUnit());
    const collection = await webflow.getCollection(collectionId);

    const project = await wxrks.createProject({
      reference: `Item Sync / ${collection.displayName || collectionId} / ${new Date().toISOString()}`,
      sourceLocale,
      orgUnitUUID,
    });
    await store.createProjectMapping(project.uuid, {
      mode: "item",
      sourceLocale,
      targetLocales,
      orgUnitUUID,
      workUnitNamePattern,
      status: "in_progress",
      wxrksStatus: "DRAFT",
    });

    const results = [];
    for (const id of ids) {
      try {
        const item = await webflow.getItem(collectionId, id, { locale: sourceLocale });
        const result = await syncItemIntoBatch({
          projectUuid: project.uuid,
          collection,
          item,
          targetLocales,
          namePattern: workUnitNamePattern,
        });
        results.push({ itemId: id, ...result });
      } catch (err) {
        results.push({ itemId: id, error: err.message });
      }
    }

    const itemsSynced = results.filter((r) => !r.skipped && !r.error).length;
    const summary = {
      itemsProcessed: results.length,
      itemsSynced,
      skipped: results.filter((r) => r.skipped).length,
      errors: results.filter((r) => r.error).length,
      estimatedWordCount: results.reduce((sum, r) => sum + (r.wordCount || 0), 0),
      wxrksProjectUUID: project.uuid,
      orgUnitUUID,
      targetLocales,
    };
    await store.setLastSync({ mode: "item", summary });

    if (autoApprove && itemsSynced > 0) {
      requestBatchApproval(project.uuid);
    }

    res.json({ ...summary, results, ...(autoApprove ? { approvalRequested: true } : {}) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/sync/status
 * Last sync summary + currently in-progress wxrks projects, for the Dashboard.
 */
router.get("/status", async (req, res) => {
  try {
    const [lastSync, activeProjects] = await Promise.all([store.getLastSync(), store.listActiveProjects()]);
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
    const history = await store.listProjectMappings();
    res.json({ history });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
