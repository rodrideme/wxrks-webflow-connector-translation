const crypto = require("crypto");
const express = require("express");
const webflow = require("../services/webflow");
const wxrks = require("../services/wxrks");
const store = require("../store");
const { syncComponentIntoBatch, requestBatchApproval } = require("../services/syncCore");

const router = express.Router();

/**
 * POST /api/sync/components/item
 * body: { componentId } or { componentIds: [...] }
 * Syncs one or more component definitions into a single wxrks project.
 * Background job pattern -- see sync.js's POST /item for why. Polled via
 * the shared GET/POST /api/sync/jobs/:jobId endpoints in sync.js.
 */
router.post("/item", async (req, res) => {
  const { componentId, componentIds, workflows, projectName } = req.body || {};
  const ids = componentIds && componentIds.length > 0 ? componentIds : componentId ? [componentId] : [];

  const accountId = req.account.id;
  try {
    const {
      sourceLocale,
      targetLocales,
      orgUnitUUID: settingsOrgUnitUUID,
      autoApprove,
      componentsWorkUnitNamePattern,
    } = await store.getSettings(accountId);

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
      reference: projectName || `Components Item Sync / ${new Date().toISOString()}`,
      sourceLocale,
      orgUnitUUID,
    });
    await store.createProjectMapping(accountId, project.uuid, {
      mode: "components-item",
      sourceLocale,
      targetLocales,
      orgUnitUUID,
      workUnitNamePattern: componentsWorkUnitNamePattern,
      status: "in_progress",
      wxrksStatus: "DRAFT",
    });

    const jobId = crypto.randomUUID();
    store.createSyncJob({ id: jobId, mode: "components-item", total: ids.length, wxrksProjectUUID: project.uuid, orgUnitUUID, targetLocales });

    res.json({ jobId, total: ids.length, wxrksProjectUUID: project.uuid, orgUnitUUID, targetLocales });

    (async () => {
      for (const id of ids) {
        if (store.getSyncJob(jobId).cancelled) break;

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
            workflows,
          });
          store.appendSyncJobResult(jobId, { webflowComponentId: id, ...result });
        } catch (err) {
          store.appendSyncJobResult(jobId, { webflowComponentId: id, error: err.message });
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
      await store.setLastSync(accountId, { mode: "components-item", summary });

      if (autoApprove && itemsSynced > 0) {
        requestBatchApproval(project.uuid);
      }
    })().catch((err) => {
      console.error(`Components item sync job ${jobId} crashed:`, err.message);
      store.updateSyncJob(jobId, { status: "error", error: err.message });
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/sync/components/list
 * All components, with per-component enabled state and (new/failed/synced)
 * per-locale delivery status, for Translate's content browser and the
 * Templates Components tab checklist. No "stale" state here -- Webflow's
 * component objects carry no modification timestamp at all (confirmed
 * live), so without an expensive per-component DOM hash there's no cheap
 * way to tell "changed since last delivery" apart from "still up to date";
 * once delivered (and not failed) a component just reads as synced.
 */
router.get("/list", async (req, res) => {
  try {
    const [settings, components, deliveryStatus] = await Promise.all([
      store.getSettings(req.account.id),
      webflow.listComponents(),
      store.getDeliveryStatusByEntity(req.account.id, "webflowComponentId"),
    ]);
    res.json({
      components: components.map((c) => {
        const localeStatus = {};
        const localeErrors = {};
        settings.targetLocales.forEach((locale) => {
          const { status, error } = store.computeLocaleStatus({
            delivery: deliveryStatus[c.id]?.[locale],
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
          : "new";
        return {
          id: c.id,
          name: c.name,
          group: c.group,
          enabled: store.isComponentEnabled(settings, c.id),
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

module.exports = router;
