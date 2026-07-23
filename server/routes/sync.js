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
    const allPages = await webflow.listPages();
    const templatePage = webflow.findCollectionTemplatePage(allPages, collectionId);

    const reference = projectName || `Item Sync / ${collection.displayName || collectionId} / ${new Date().toISOString()}`;
    const project = await wxrks.createProject({ reference, sourceLocale, orgUnitUUID });
    await store.createProjectMapping(accountId, project.uuid, {
      mode: "item",
      reference,
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
            templatePage,
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
    // One unfiltered pages fetch, shared by BOTH the collection branch's
    // template-page lookup and the pagesFolder branch's page list below --
    // listStaticPages() is just this same list minus collection-template
    // pages, so there's no reason to fetch it twice.
    const allPagesRaw = needsSite ? await webflow.listPages() : [];

    const reference = projectName || `Combined Sync / ${new Date().toISOString()}`;
    const project = await wxrks.createProject({ reference, sourceLocale, orgUnitUUID });
    await store.createProjectMapping(accountId, project.uuid, {
      mode: "combined",
      reference,
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
          const templatePage = webflow.findCollectionTemplatePage(allPagesRaw, g.leafId);
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
                templatePage,
              });
              store.appendSyncJobResult(jobId, { itemId: id, ...result });
            } catch (err) {
              store.appendSyncJobResult(jobId, { itemId: id, error: err.message });
            }
          }
        } else if (g.kind === "pagesFolder") {
          const allPages = allPagesRaw.filter((p) => !p.collectionId);
          const pagesById = new Map(allPages.map((p) => [p.id, p]));
          const foldersById = await webflow.getPageFoldersByIds(g.ids.map((id) => pagesById.get(id)?.parentId));
          for (const id of g.ids) {
            if (store.getSyncJob(jobId).cancelled) break;
            try {
              const page = pagesById.get(id);
              if (!page) throw new Error(`Page ${id} not found`);
              const nodes = await webflow.getPageDom(id, { locale: sourceLocale });
              const result = await syncPageIntoBatch({
                accountId,
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
                accountId,
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
 * GET /api/sync/history?limit=&offset=&search=
 * Every batch ever created (not just active ones), most recent first --
 * each entry carries the full settings snapshot (org unit, locales,
 * collections, naming pattern) that produced its wxrks project.
 *
 * Pagination is opt-in: Dashboard computes account-wide aggregates (total
 * runs, total words translated) that need the COMPLETE history, so a
 * no-params call keeps returning everything, unchanged. The Runs page's
 * History tab only ever needs to browse a page at a time, so it passes
 * limit/offset to get a real paginated query instead -- same "no total-
 * count, client treats a full page as 'there might be more'" convention
 * as listActivity/getActivity. `search` (only meaningful alongside paging)
 * matches server-side against the whole account's history, not just
 * whatever page happens to be loaded client-side -- a client-side-only
 * filter would silently miss any match sitting on an unloaded page.
 */
router.get("/history", async (req, res) => {
  try {
    const hasPaging = req.query.limit !== undefined || req.query.offset !== undefined;
    const history = hasPaging
      ? await store.listProjectMappingsPage(req.account.id, {
          limit: Math.min(Number(req.query.limit) || 20, 100),
          offset: Number(req.query.offset) || 0,
          search: req.query.search?.trim() || undefined,
        })
      : await store.listProjectMappings(req.account.id);
    res.json({ history });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/sync/history/:wxrksProjectUUID/work-units
 * One row per (item, target locale) synced in this one run -- lazily
 * fetched by the Runs page when a History card is expanded, not bundled
 * into GET /history itself. Each row's `webflowUrl` is always a Webflow
 * Designer deep link (never a live/published preview URL) -- too many
 * real-world variations (locale subdirectories, draft status, slug
 * differences per locale) made the preview path unreliable, so users are
 * always sent to the Designer instead.
 */
// This route recomputes real, non-trivial live Webflow work every call
// (per-locale item reads, a pages/folders fetch -- see below). A run
// older than an hour has almost certainly had every one of its
// deliveries settle already (Webflow webhooks fire within seconds/
// minutes, not hours) and its item/locale set never changes after
// creation, so its result is safe to treat as effectively permanent --
// most History rows are old runs, and redoing this work for them on
// every single page load was pure waste. Young (possibly still-
// delivering) runs get a short TTL instead, just enough to dedupe rapid
// repeat requests for the same run. Keyed by wxrksProjectUUID alone
// (globally unique) -- ownership is still checked fresh from the DB on
// every request before this cache is ever consulted, so this isn't a
// security shortcut. In-memory, not DB-persisted, matching every other
// cache in this codebase (webflow.js's makeTtlCache/
// siteLocalesCacheByAccount) -- fine for a process-lifetime performance
// optimization, and this app restarts rarely outside active local dev.
const WORK_UNITS_CACHE = new Map(); // uuid -> { rows, expiresAt }
const OLD_RUN_THRESHOLD_MS = 60 * 60 * 1000;
const OLD_RUN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const YOUNG_RUN_CACHE_TTL_MS = 30 * 1000;

router.get("/history/:wxrksProjectUUID/work-units", async (req, res) => {
  try {
    const mapping = await store.getProjectMapping(req.params.wxrksProjectUUID);
    // Looked up by uuid directly (globally unique, assigned by wxrks) --
    // unlike listProjectMappings above, this needs its own explicit
    // ownership check so one account can't fetch another's run.
    if (!mapping || mapping.accountId !== req.account.id) {
      return res.status(404).json({ error: "Run not found" });
    }

    const cached = WORK_UNITS_CACHE.get(req.params.wxrksProjectUUID);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ rows: cached.rows });
    }

    const { site } = await webflow.getSiteLocales();

    const hasCmsItems = mapping.items.some((item) => (item.entityType || "cmsItem") === "cmsItem");
    const hasPages = mapping.items.some((item) => item.entityType === "page");

    const allPagesRaw = hasCmsItems ? await webflow.listPages() : [];
    const templatePageByCollection = new Map();

    const staticPages = hasPages ? await webflow.listStaticPages() : [];
    const pagesById = new Map(staticPages.map((p) => [p.id, p]));

    const latestUpdateByEntity = store.latestUpdateByEntityAndLocale(mapping);

    const rows = [];
    for (const item of mapping.items) {
      const entityType = item.entityType || "cmsItem";
      const entityId = item.webflowItemId || item.webflowPageId || item.webflowComponentId;

      for (const locale of mapping.targetLocales) {
        const delivery = latestUpdateByEntity[entityId]?.[locale];
        let webflowUrl;
        let linkType;

        // Always the Designer deep-link, never a live/published preview
        // URL -- too many real-world variations (locale subdirectories,
        // draft status, slug differences per locale) made the preview
        // path unreliable. This also drops the per-collection-locale
        // draft-status fetch that used to exist solely to feed that
        // preview branch (was real, non-trivial Webflow API load).
        if (entityType === "cmsItem") {
          if (!templatePageByCollection.has(item.webflowCollectionId)) {
            templatePageByCollection.set(item.webflowCollectionId, webflow.findCollectionTemplatePage(allPagesRaw, item.webflowCollectionId));
          }
          const templatePage = templatePageByCollection.get(item.webflowCollectionId);
          webflowUrl = webflow.buildCmsItemDesignerUrl({ site, templatePage, item: { id: item.webflowItemId }, locale });
          linkType = "designer";
        } else if (entityType === "page") {
          const page = pagesById.get(item.webflowPageId);
          if (!page) {
            // Page no longer exists (deleted since this run) -- nothing to
            // link to.
            webflowUrl = undefined;
            linkType = "none";
          } else {
            webflowUrl = webflow.buildPageDesignerUrl({ site, page, locale });
            linkType = "designer";
          }
        } else {
          // Components have no addressable URL -- no page association is
          // ever stored for where a given instance lives.
          webflowUrl = undefined;
          linkType = "none";
        }

        rows.push({
          entityType,
          // Lets the client reliably group a document's several target-
          // locale rows back into one row per document -- workUnitName
          // alone (a user-configurable naming pattern) isn't guaranteed
          // unique across different documents if the pattern omits
          // {collection}/{entry} tokens.
          entityId,
          workUnitName: item.resourceFileName,
          targetLocale: locale,
          sentToWxrksAt: mapping.createdAt,
          updatedOnWebflowAt: delivery?.updatedAt || null,
          updateError: delivery?.error || null,
          webflowUrl,
          linkType,
        });
      }
    }

    const isOldRun = Date.now() - new Date(mapping.createdAt).getTime() > OLD_RUN_THRESHOLD_MS;
    WORK_UNITS_CACHE.set(req.params.wxrksProjectUUID, {
      rows,
      expiresAt: Date.now() + (isOldRun ? OLD_RUN_CACHE_TTL_MS : YOUNG_RUN_CACHE_TTL_MS),
    });

    res.json({ rows });
  } catch (err) {
    res.status(502).json({ error: err.response?.data?.message || err.message });
  }
});

module.exports = router;
