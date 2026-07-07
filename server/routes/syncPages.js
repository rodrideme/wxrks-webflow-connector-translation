const crypto = require("crypto");
const express = require("express");
const webflow = require("../services/webflow");
const webflowDom = require("../services/webflowDom");
const wxrks = require("../services/wxrks");
const store = require("../store");
const { syncPageIntoBatch, requestBatchApproval } = require("../services/syncCore");

const router = express.Router();

/**
 * Resolves which static pages a bulk pages sync would touch, without
 * changing anything. Mirrors sync.js's planBulkSync. No translateFromDate
 * filter for v1 -- there's no confirmed cheap "content changed since X"
 * signal for pages (see plan's Open Risk #4), and it only matters for Auto
 * Sync anyway, which is deferred for pages.
 */
async function planPagesBulkSync(settings) {
  const allPages = await webflow.listStaticPages();
  return allPages.filter((p) => store.isPageEnabled(settings, p.id));
}

/**
 * POST /api/sync/pages/bulk
 * body: { dryRun?: boolean }
 * Same dry-run/background-job shape as CMS's POST /api/sync/bulk.
 */
router.post("/bulk", async (req, res) => {
  const { dryRun } = req.body || {};

  try {
    const settings = await store.getSettings();
    const { sourceLocale, targetLocales, orgUnitUUID: settingsOrgUnitUUID, autoApprove, pagesWorkUnitNamePattern } =
      settings;

    if (targetLocales.length === 0) {
      return res.status(400).json({ error: "No target locales configured. Set them in Settings first." });
    }

    const pages = await planPagesBulkSync(settings);

    if (dryRun) {
      let estimatedWordCount = 0;
      for (const page of pages) {
        const nodes = await webflow.getPageDom(page.id, { locale: sourceLocale });
        const translatableNodes = webflowDom.extractTextNodes(nodes);
        estimatedWordCount += webflow.countWords(translatableNodes);
      }
      return res.json({ totalPages: pages.length, estimatedWordCount });
    }

    if (pages.length === 0) {
      await store.setLastSync({ mode: "pages-bulk", summary: { itemsProcessed: 0, itemsSynced: 0 } });
      return res.json({ total: 0, message: "No pages matched the current filter." });
    }

    const orgUnitUUID = settingsOrgUnitUUID || (await wxrks.getOrgUnit());
    const project = await wxrks.createProject({
      reference: `Pages Bulk Sync ${new Date().toISOString()}`,
      sourceLocale,
      orgUnitUUID,
    });
    await store.createProjectMapping(project.uuid, {
      mode: "pages-bulk",
      sourceLocale,
      targetLocales,
      orgUnitUUID,
      workUnitNamePattern: pagesWorkUnitNamePattern,
      status: "in_progress",
      wxrksStatus: "DRAFT",
    });

    const jobId = crypto.randomUUID();
    store.createSyncJob({
      id: jobId,
      mode: "pages-bulk",
      total: pages.length,
      wxrksProjectUUID: project.uuid,
      orgUnitUUID,
      targetLocales,
    });

    res.json({ jobId, total: pages.length, wxrksProjectUUID: project.uuid, orgUnitUUID, targetLocales });

    (async () => {
      for (const page of pages) {
        if (store.getSyncJob(jobId).cancelled) break;

        try {
          const nodes = await webflow.getPageDom(page.id, { locale: sourceLocale });
          const result = await syncPageIntoBatch({
            projectUuid: project.uuid,
            page,
            nodes,
            targetLocales,
            namePattern: pagesWorkUnitNamePattern,
          });
          store.appendSyncJobResult(jobId, { webflowPageId: page.id, ...result });
        } catch (err) {
          store.appendSyncJobResult(jobId, { webflowPageId: page.id, error: err.message });
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
      await store.setLastSync({ mode: "pages-bulk", summary });

      if (autoApprove && itemsSynced > 0) {
        requestBatchApproval(project.uuid);
      }
    })().catch((err) => {
      console.error(`Pages bulk sync job ${jobId} crashed:`, err.message);
      store.updateSyncJob(jobId, { status: "error", error: err.message });
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/sync/pages/bulk/:jobId
 */
router.get("/bulk/:jobId", (req, res) => {
  const job = store.getSyncJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

/**
 * POST /api/sync/pages/bulk/:jobId/cancel
 */
router.post("/bulk/:jobId/cancel", (req, res) => {
  const job = store.cancelSyncJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

/**
 * POST /api/sync/pages/item
 * body: { pageId } or { pageIds: [...] }
 * Syncs one or more static pages into a single wxrks project.
 */
router.post("/item", async (req, res) => {
  const { pageId, pageIds } = req.body || {};
  const ids = pageIds && pageIds.length > 0 ? pageIds : pageId ? [pageId] : [];

  try {
    const {
      sourceLocale,
      targetLocales,
      orgUnitUUID: settingsOrgUnitUUID,
      autoApprove,
      pagesWorkUnitNamePattern,
    } = await store.getSettings();

    if (ids.length === 0) {
      return res.status(400).json({ error: "At least one pageId is required" });
    }
    if (targetLocales.length === 0) {
      return res.status(400).json({ error: "No target locales configured. Set them in Settings first." });
    }

    const orgUnitUUID = settingsOrgUnitUUID || (await wxrks.getOrgUnit());
    const allPages = await webflow.listStaticPages();
    const pagesById = new Map(allPages.map((p) => [p.id, p]));

    const project = await wxrks.createProject({
      reference: `Pages Item Sync / ${new Date().toISOString()}`,
      sourceLocale,
      orgUnitUUID,
    });
    await store.createProjectMapping(project.uuid, {
      mode: "pages-item",
      sourceLocale,
      targetLocales,
      orgUnitUUID,
      workUnitNamePattern: pagesWorkUnitNamePattern,
      status: "in_progress",
      wxrksStatus: "DRAFT",
    });

    const results = [];
    for (const id of ids) {
      try {
        const page = pagesById.get(id);
        if (!page) throw new Error(`Page ${id} not found`);
        const nodes = await webflow.getPageDom(id, { locale: sourceLocale });
        const result = await syncPageIntoBatch({
          projectUuid: project.uuid,
          page,
          nodes,
          targetLocales,
          namePattern: pagesWorkUnitNamePattern,
        });
        results.push({ webflowPageId: id, ...result });
      } catch (err) {
        results.push({ webflowPageId: id, error: err.message });
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
    await store.setLastSync({ mode: "pages-item", summary });

    if (autoApprove && itemsSynced > 0) {
      requestBatchApproval(project.uuid);
    }

    res.json({ ...summary, results, ...(autoApprove ? { approvalRequested: true } : {}) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/sync/pages/list
 * All static pages, with per-page enabled state, for the Sync Panel /
 * Settings Pages tab checklists.
 */
router.get("/list", async (req, res) => {
  try {
    const settings = await store.getSettings();
    const pages = await webflow.listStaticPages();
    res.json({
      pages: pages.map((p) => ({
        id: p.id,
        title: p.title,
        slug: p.slug,
        lastUpdated: p.lastUpdated,
        enabled: store.isPageEnabled(settings, p.id),
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
