const crypto = require("crypto");
const express = require("express");
const webflow = require("../services/webflow");
const wxrks = require("../services/wxrks");
const store = require("../store");
const { syncItemIntoBatch, syncPageIntoBatch, syncComponentIntoBatch, requestBatchApproval } = require("../services/syncCore");
const { requireWriteAccess } = require("../middleware/auth");

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
router.post("/item", requireWriteAccess, async (req, res) => {
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
    // Fetched once for the whole request (not per item) -- feeds
    // syncItemIntoBatch's previewUrl computation below.
    const { site } = await webflow.getSiteLocales();

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
    store.recordActivity(accountId, req.user.id, "sync.item", { collectionName: collection.displayName, itemCount: ids.length }).catch(() => {});

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
            site,
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
    if (err.code === "WXRKS_NOT_CONNECTED") {
      return res.status(409).json({ error: err.message, code: "wxrks_not_connected" });
    }
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/sync/combined
 * body: { groups: [{ kind: "collection"|"pagesFolder"|"components", leafId?, ids }], workflows, projectName, orgUnitUUID, targetLocales }
 * Sends items spanning multiple collections/pages/components into a single
 * shared wxrks project instead of one project per group -- the default
 * behavior (settings.combineIntoOneProject) once a selection spans more
 * than one kind/collection. Mirrors autoSyncQueue.js's flush(), which
 * already does exactly this for automations (one project per batch,
 * regardless of how many entity types it contains); this is the same
 * pattern for a one-time send instead of a scheduled batch.
 */
router.post("/combined", requireWriteAccess, async (req, res) => {
  const { groups, workflows, projectName, orgUnitUUID: orgUnitUUIDOverride, targetLocales: targetLocalesOverride } = req.body || {};
  const accountId = req.account.id;
  try {
    const {
      sourceLocale,
      targetLocales: settingsTargetLocales,
      orgUnitUUID: settingsOrgUnitUUID,
      autoApprove,
      workUnitNamePattern,
      pagesWorkUnitNamePattern,
      componentsWorkUnitNamePattern,
    } = await store.getSettings(accountId);
    const targetLocales = targetLocalesOverride?.length ? targetLocalesOverride : settingsTargetLocales;

    if (!Array.isArray(groups) || groups.length === 0) {
      return res.status(400).json({ error: "At least one group is required" });
    }
    if (targetLocales.length === 0) {
      return res.status(400).json({ error: "No target locales configured. Set them in Settings first." });
    }

    const orgUnitUUID = orgUnitUUIDOverride || settingsOrgUnitUUID || (await wxrks.getOrgUnit());
    const totalItems = groups.reduce((sum, g) => sum + (g.ids?.length || 0), 0);
    // Fetched once for the whole request (not per group/item) -- feeds
    // syncItemIntoBatch/syncPageIntoBatch's previewUrl computation below.
    // Skipped entirely for an all-components batch, since neither group
    // kind that needs it is present -- same guard idiom as orgUnitUUID above.
    const needsSite = groups.some((g) => g.kind === "collection" || g.kind === "pagesFolder");
    const { site } = needsSite ? await webflow.getSiteLocales() : { site: null };

    const project = await wxrks.createProject({
      reference: projectName || `Combined Sync / ${new Date().toISOString()}`,
      sourceLocale,
      orgUnitUUID,
    });
    await store.createProjectMapping(accountId, project.uuid, {
      mode: "combined",
      sourceLocale,
      targetLocales,
      orgUnitUUID,
      workUnitNamePattern,
      status: "in_progress",
      wxrksStatus: "DRAFT",
    });

    const jobId = crypto.randomUUID();
    store.createSyncJob({ id: jobId, mode: "combined", total: totalItems, wxrksProjectUUID: project.uuid, orgUnitUUID, targetLocales });
    store.recordActivity(accountId, req.user.id, "sync.combined", { groupCount: groups.length, itemCount: totalItems }).catch(() => {});

    res.json({ jobId, total: totalItems, wxrksProjectUUID: project.uuid, orgUnitUUID, targetLocales });

    // Runs after the response is sent, same "respond fast, process in
    // background" pattern as every other one-time send endpoint above.
    (async () => {
      for (const g of groups) {
        if (store.getSyncJob(jobId).cancelled) break;

        if (g.kind === "collection") {
          const collection = await webflow.getCollection(g.leafId);
          for (const id of g.ids) {
            if (store.getSyncJob(jobId).cancelled) break;
            try {
              const item = await webflow.getItem(g.leafId, id, { locale: sourceLocale });
              const result = await syncItemIntoBatch({
                accountId,
                projectUuid: project.uuid,
                collection,
                item,
                targetLocales,
                namePattern: workUnitNamePattern,
                workflows,
                site,
              });
              store.appendSyncJobResult(jobId, { itemId: id, ...result });
            } catch (err) {
              store.appendSyncJobResult(jobId, { itemId: id, error: err.message });
            }
          }
        } else if (g.kind === "pagesFolder") {
          const allPages = await webflow.listStaticPages();
          const pagesById = new Map(allPages.map((p) => [p.id, p]));
          const foldersById = await webflow.getPageFoldersByIds(g.ids.map((id) => pagesById.get(id)?.parentId));
          for (const id of g.ids) {
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
                site,
                folder: foldersById.get(page.parentId),
              });
              store.appendSyncJobResult(jobId, { webflowPageId: id, ...result });
            } catch (err) {
              store.appendSyncJobResult(jobId, { webflowPageId: id, error: err.message });
            }
          }
        } else {
          const allComponents = await webflow.listComponents();
          const componentsById = new Map(allComponents.map((c) => [c.id, c]));
          for (const id of g.ids) {
            if (store.getSyncJob(jobId).cancelled) break;
            try {
              const component = componentsById.get(id);
              if (!component) throw new Error(`Component ${id} not found`);
              const nodes = await webflow.getComponentDom(id, { locale: sourceLocale });
              const properties = await webflow.getComponentProperties(id, { locale: sourceLocale });
              const result = await syncComponentIntoBatch({
                projectUuid: project.uuid,
                component,
                nodes,
                properties,
                targetLocales,
                namePattern: componentsWorkUnitNamePattern,
                workflows,
              });
              store.appendSyncJobResult(jobId, { webflowComponentId: id, ...result });
            } catch (err) {
              store.appendSyncJobResult(jobId, { webflowComponentId: id, error: err.message });
            }
          }
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
      await store.setLastSync(accountId, { mode: "combined", summary });

      if (autoApprove && itemsSynced > 0) {
        requestBatchApproval(project.uuid);
      }
    })().catch((err) => {
      console.error(`Combined sync job ${jobId} crashed:`, err.message);
      store.updateSyncJob(jobId, { status: "error", error: err.message });
    });
  } catch (err) {
    if (err.code === "WXRKS_NOT_CONNECTED") {
      return res.status(409).json({ error: err.message, code: "wxrks_not_connected" });
    }
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
