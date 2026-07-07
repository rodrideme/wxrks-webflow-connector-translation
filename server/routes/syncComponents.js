const crypto = require("crypto");
const express = require("express");
const webflow = require("../services/webflow");
const webflowDom = require("../services/webflowDom");
const wxrks = require("../services/wxrks");
const store = require("../store");
const { syncComponentIntoBatch, requestBatchApproval } = require("../services/syncCore");

const router = express.Router();

/**
 * Resolves which components a bulk sync would touch, without changing
 * anything. Mirrors syncPages.js's planPagesBulkSync. No translateFromDate
 * filter for v1 -- same reasoning as pages (no cheap "changed since"
 * signal, only matters for Auto Sync which is deferred).
 */
async function planComponentsBulkSync(settings) {
  const allComponents = await webflow.listComponents();
  return allComponents.filter((c) => store.isComponentEnabled(settings, c.id));
}

/**
 * POST /api/sync/components/bulk
 * body: { dryRun?: boolean }
 * Same dry-run/background-job shape as Pages' POST /api/sync/pages/bulk.
 */
router.post("/bulk", async (req, res) => {
  const { dryRun } = req.body || {};

  try {
    const settings = await store.getSettings();
    const { sourceLocale, targetLocales, orgUnitUUID: settingsOrgUnitUUID, autoApprove, componentsWorkUnitNamePattern } =
      settings;

    if (targetLocales.length === 0) {
      return res.status(400).json({ error: "No target locales configured. Set them in Settings first." });
    }

    const components = await planComponentsBulkSync(settings);

    if (dryRun) {
      let estimatedWordCount = 0;
      for (const component of components) {
        const nodes = await webflow.getComponentDom(component.id, { locale: sourceLocale });
        const translatableNodes = webflowDom.extractTextNodes(nodes);
        estimatedWordCount += webflow.countWords(translatableNodes);
      }
      return res.json({ totalComponents: components.length, estimatedWordCount });
    }

    if (components.length === 0) {
      await store.setLastSync({ mode: "components-bulk", summary: { itemsProcessed: 0, itemsSynced: 0 } });
      return res.json({ total: 0, message: "No components matched the current filter." });
    }

    const orgUnitUUID = settingsOrgUnitUUID || (await wxrks.getOrgUnit());
    const project = await wxrks.createProject({
      reference: `Components Bulk Sync ${new Date().toISOString()}`,
      sourceLocale,
      orgUnitUUID,
    });
    await store.createProjectMapping(project.uuid, {
      mode: "components-bulk",
      sourceLocale,
      targetLocales,
      orgUnitUUID,
      workUnitNamePattern: componentsWorkUnitNamePattern,
      status: "in_progress",
      wxrksStatus: "DRAFT",
    });

    const jobId = crypto.randomUUID();
    store.createSyncJob({
      id: jobId,
      mode: "components-bulk",
      total: components.length,
      wxrksProjectUUID: project.uuid,
      orgUnitUUID,
      targetLocales,
    });

    res.json({ jobId, total: components.length, wxrksProjectUUID: project.uuid, orgUnitUUID, targetLocales });

    (async () => {
      for (const component of components) {
        if (store.getSyncJob(jobId).cancelled) break;

        try {
          const nodes = await webflow.getComponentDom(component.id, { locale: sourceLocale });
          const result = await syncComponentIntoBatch({
            projectUuid: project.uuid,
            component,
            nodes,
            targetLocales,
            namePattern: componentsWorkUnitNamePattern,
          });
          store.appendSyncJobResult(jobId, { webflowComponentId: component.id, ...result });
        } catch (err) {
          store.appendSyncJobResult(jobId, { webflowComponentId: component.id, error: err.message });
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
      await store.setLastSync({ mode: "components-bulk", summary });

      if (autoApprove && itemsSynced > 0) {
        requestBatchApproval(project.uuid);
      }
    })().catch((err) => {
      console.error(`Components bulk sync job ${jobId} crashed:`, err.message);
      store.updateSyncJob(jobId, { status: "error", error: err.message });
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/sync/components/bulk/:jobId
 */
router.get("/bulk/:jobId", (req, res) => {
  const job = store.getSyncJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

/**
 * POST /api/sync/components/bulk/:jobId/cancel
 */
router.post("/bulk/:jobId/cancel", (req, res) => {
  const job = store.cancelSyncJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

/**
 * POST /api/sync/components/item
 * body: { componentId } or { componentIds: [...] }
 * Syncs one or more component definitions into a single wxrks project.
 */
router.post("/item", async (req, res) => {
  const { componentId, componentIds } = req.body || {};
  const ids = componentIds && componentIds.length > 0 ? componentIds : componentId ? [componentId] : [];

  try {
    const {
      sourceLocale,
      targetLocales,
      orgUnitUUID: settingsOrgUnitUUID,
      autoApprove,
      componentsWorkUnitNamePattern,
    } = await store.getSettings();

    if (ids.length === 0) {
      return res.status(400).json({ error: "At least one componentId is required" });
    }
    if (targetLocales.length === 0) {
      return res.status(400).json({ error: "No target locales configured. Set them in Settings first." });
    }

    const orgUnitUUID = settingsOrgUnitUUID || (await wxrks.getOrgUnit());
    const allComponents = await webflow.listComponents();
    const componentsById = new Map(allComponents.map((c) => [c.id, c]));

    const project = await wxrks.createProject({
      reference: `Components Item Sync / ${new Date().toISOString()}`,
      sourceLocale,
      orgUnitUUID,
    });
    await store.createProjectMapping(project.uuid, {
      mode: "components-item",
      sourceLocale,
      targetLocales,
      orgUnitUUID,
      workUnitNamePattern: componentsWorkUnitNamePattern,
      status: "in_progress",
      wxrksStatus: "DRAFT",
    });

    const results = [];
    for (const id of ids) {
      try {
        const component = componentsById.get(id);
        if (!component) throw new Error(`Component ${id} not found`);
        const nodes = await webflow.getComponentDom(id, { locale: sourceLocale });
        const result = await syncComponentIntoBatch({
          projectUuid: project.uuid,
          component,
          nodes,
          targetLocales,
          namePattern: componentsWorkUnitNamePattern,
        });
        results.push({ webflowComponentId: id, ...result });
      } catch (err) {
        results.push({ webflowComponentId: id, error: err.message });
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
    await store.setLastSync({ mode: "components-item", summary });

    if (autoApprove && itemsSynced > 0) {
      requestBatchApproval(project.uuid);
    }

    res.json({ ...summary, results, ...(autoApprove ? { approvalRequested: true } : {}) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/sync/components/list
 * All components, with per-component enabled state, for the Sync Panel /
 * Settings Components tab checklists.
 */
router.get("/list", async (req, res) => {
  try {
    const settings = await store.getSettings();
    const components = await webflow.listComponents();
    res.json({
      components: components.map((c) => ({
        id: c.id,
        name: c.name,
        group: c.group,
        enabled: store.isComponentEnabled(settings, c.id),
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
