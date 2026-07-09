const crypto = require("crypto");
const express = require("express");
const webflow = require("../services/webflow");
const wxrks = require("../services/wxrks");
const store = require("../store");
const { syncPageIntoBatch, requestBatchApproval } = require("../services/syncCore");

const router = express.Router();

/**
 * POST /api/sync/pages/item
 * body: { pageId } or { pageIds: [...] }
 * Syncs one or more static pages into a single wxrks project. Background
 * job pattern -- see sync.js's POST /item for why (a large folder/"All
 * content" send can take minutes). Polled via the shared
 * GET/POST /api/sync/jobs/:jobId endpoints in sync.js.
 */
router.post("/item", async (req, res) => {
  const {
    pageId,
    pageIds,
    workflows,
    projectName,
    orgUnitUUID: orgUnitUUIDOverride,
    targetLocales: targetLocalesOverride,
  } = req.body || {};
  const ids = pageIds && pageIds.length > 0 ? pageIds : pageId ? [pageId] : [];

  const accountId = req.account.id;
  try {
    const {
      sourceLocale,
      targetLocales: settingsTargetLocales,
      orgUnitUUID: settingsOrgUnitUUID,
      autoApprove,
      pagesWorkUnitNamePattern,
    } = await store.getSettings(accountId);
    const targetLocales = targetLocalesOverride?.length ? targetLocalesOverride : settingsTargetLocales;

    if (ids.length === 0) {
      return res.status(400).json({ error: "At least one pageId is required" });
    }
    if (targetLocales.length === 0) {
      return res.status(400).json({ error: "No target locales configured. Set them in Settings first." });
    }

    const orgUnitUUID = orgUnitUUIDOverride || settingsOrgUnitUUID || (await wxrks.getOrgUnit());
    const allPages = await webflow.listStaticPages();
    const pagesById = new Map(allPages.map((p) => [p.id, p]));

    const project = await wxrks.createProject({
      reference: projectName || `Pages Item Sync / ${new Date().toISOString()}`,
      sourceLocale,
      orgUnitUUID,
    });
    await store.createProjectMapping(accountId, project.uuid, {
      mode: "pages-item",
      sourceLocale,
      targetLocales,
      orgUnitUUID,
      workUnitNamePattern: pagesWorkUnitNamePattern,
      status: "in_progress",
      wxrksStatus: "DRAFT",
    });

    const jobId = crypto.randomUUID();
    store.createSyncJob({ id: jobId, mode: "pages-item", total: ids.length, wxrksProjectUUID: project.uuid, orgUnitUUID, targetLocales });

    res.json({ jobId, total: ids.length, wxrksProjectUUID: project.uuid, orgUnitUUID, targetLocales });

    (async () => {
      for (const id of ids) {
        if (store.getSyncJob(jobId).cancelled) break;

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
            workflows,
          });
          store.appendSyncJobResult(jobId, { webflowPageId: id, ...result });
        } catch (err) {
          store.appendSyncJobResult(jobId, { webflowPageId: id, error: err.message });
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
      await store.setLastSync(accountId, { mode: "pages-item", summary });

      if (autoApprove && itemsSynced > 0) {
        requestBatchApproval(project.uuid);
      }
    })().catch((err) => {
      console.error(`Pages item sync job ${jobId} crashed:`, err.message);
      store.updateSyncJob(jobId, { status: "error", error: err.message });
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/sync/pages/list
 * All static pages, with per-page enabled state and (new/stale/failed/
 * synced) per-locale delivery status, for Translate's content browser and
 * the Templates Pages tab checklist. Status comes entirely from our own
 * delivery log compared against page.lastUpdated -- no per-locale DOM
 * fetch needed (that's the expensive N+1 this app deliberately avoids for
 * Pages/Components list views), since we don't need to know whether a
 * locale-specific override exists in Webflow, only whether *we* delivered
 * one and whether the source has changed since.
 */
router.get("/list", async (req, res) => {
  try {
    const [settings, pages, deliveryStatus] = await Promise.all([
      store.getSettings(req.account.id),
      webflow.listStaticPages(),
      store.getDeliveryStatusByEntity(req.account.id, "webflowPageId"),
    ]);
    res.json({
      pages: pages.map((p) => {
        const localeStatus = {};
        const localeErrors = {};
        settings.targetLocales.forEach((locale) => {
          const { status, error } = store.computeLocaleStatus({
            delivery: deliveryStatus[p.id]?.[locale],
            sourceLastUpdated: p.lastUpdated,
            localeExists: false,
          });
          localeStatus[locale] = status;
          if (error) localeErrors[locale] = error;
        });
        const localeStates = Object.values(localeStatus);
        const state = localeStates.includes("failed")
          ? "failed"
          : localeStates.every((s) => s === "synced")
          ? "synced"
          : localeStates.every((s) => s === "new")
          ? "new"
          : "stale";
        return {
          id: p.id,
          title: p.title,
          slug: p.slug,
          folderId: p.parentId || null,
          lastUpdated: p.lastUpdated,
          state,
          localeStatus,
          localeErrors,
        };
      }),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/sync/pages/folders
 * Every folder in use, with page counts, for the Automation wizard's Pages
 * scope picker.
 */
router.get("/folders", async (req, res) => {
  try {
    const folders = await webflow.listPageFolders();
    res.json({ folders });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
