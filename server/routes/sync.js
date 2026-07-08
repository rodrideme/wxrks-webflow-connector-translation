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
 * single wxrks project.
 */
router.post("/item", async (req, res) => {
  const { collectionId, itemId, itemIds, workflows, projectName } = req.body || {};
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
      reference: projectName || `Item Sync / ${collection.displayName || collectionId} / ${new Date().toISOString()}`,
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
          workflows,
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
