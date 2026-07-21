const crypto = require("crypto");
const express = require("express");
const webflow = require("../services/webflow");
const wxrks = require("../services/wxrks");
const store = require("../store");
const { syncComponentIntoBatch, requestBatchApproval } = require("../services/syncCore");
const { requireWriteAccess } = require("../middleware/auth");

const router = express.Router();

/**
 * POST /api/sync/components/item
 * body: { componentId } or { componentIds: [...] }
 * Syncs one or more component definitions into a single wxrks project.
 * Background job pattern -- see sync.js's POST /item for why. Polled via
 * the shared GET/POST /api/sync/jobs/:jobId endpoints in sync.js.
 */
router.post("/item", requireWriteAccess, async (req, res) => {
  const {
    componentId,
    componentIds,
    workflows,
    projectName,
    orgUnitUUID: orgUnitUUIDOverride,
    targetLocales: targetLocalesOverride,
  } = req.body || {};
  const ids = componentIds && componentIds.length > 0 ? componentIds : componentId ? [componentId] : [];

  const accountId = req.account.id;
  try {
    const {
      sourceLocale,
      targetLocales: settingsTargetLocales,
      orgUnitUUID: settingsOrgUnitUUID,
      autoApprove,
      componentsWorkUnitNamePattern,
    } = await store.getSettings(accountId);
    const targetLocales = targetLocalesOverride?.length ? targetLocalesOverride : settingsTargetLocales;

    if (ids.length === 0) {
      return res.status(400).json({ error: "At least one componentId is required" });
    }
    if (targetLocales.length === 0) {
      return res.status(400).json({ error: "No target locales configured. Set them in Settings first." });
    }

    const orgUnitUUID = orgUnitUUIDOverride || settingsOrgUnitUUID || (await wxrks.getOrgUnit());
    const allComponents = await webflow.listComponents();
    const componentsById = new Map(allComponents.map((c) => [c.id, c]));

    const reference = projectName || `Components Item Sync / ${new Date().toISOString()}`;
    const project = await wxrks.createProject({ reference, sourceLocale, orgUnitUUID });
    await store.createProjectMapping(accountId, project.uuid, {
      mode: "components-item",
      reference,
      sourceLocale,
      targetLocales,
      orgUnitUUID,
      workUnitNamePattern: componentsWorkUnitNamePattern,
      status: "in_progress",
      wxrksStatus: "DRAFT",
    });

    const jobId = crypto.randomUUID();
    store.createSyncJob({ id: jobId, mode: "components-item", total: ids.length, wxrksProjectUUID: project.uuid, orgUnitUUID, targetLocales });
    store.recordActivity(accountId, req.user.id, "sync.components_item", { itemCount: ids.length }).catch(() => {});

    res.json({ jobId, total: ids.length, wxrksProjectUUID: project.uuid, orgUnitUUID, targetLocales });

    (async () => {
      for (const id of ids) {
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
    if (err.code === "WXRKS_NOT_CONNECTED") {
      return res.status(409).json({ error: err.message, code: "wxrks_not_connected" });
    }
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/sync/components/:id/properties
 * A component definition's real Properties (propertyId/type/label), merged
 * with any user-configured exclusions, for the property-exclusion UI.
 * Mirrors collections.js's GET /:id/fields -- needs sourceLocale first,
 * unlike that route, since Component Properties (unlike CMS field schema)
 * are fetched per-locale.
 */
router.get("/:id/properties", async (req, res) => {
  try {
    const { sourceLocale } = await store.getSettings(req.account.id);
    const [properties, exclusions] = await Promise.all([
      webflow.getComponentProperties(req.params.id, { locale: sourceLocale }),
      store.getComponentPropertyExclusions(req.account.id, req.params.id),
    ]);
    const excluded = new Set(exclusions);

    res.json({
      properties: properties.map((p) => ({
        propertyId: p.propertyId,
        type: p.type,
        label: p.label,
        excluded: excluded.has(p.propertyId),
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.response?.data?.message || err.message });
  }
});

/**
 * PUT /api/sync/components/:id/property-exclusions
 * body: { excludedPropertyIds: string[] }
 * Explicit propertyId overrides -- unlike CMS field exclusions there's no
 * automatic type-based filter underneath these, since Webflow's Property
 * types can't distinguish real text from a config value using the same type.
 */
router.put("/:id/property-exclusions", requireWriteAccess, async (req, res) => {
  try {
    const { excludedPropertyIds } = req.body || {};
    const updated = await store.setComponentPropertyExclusions(req.account.id, req.params.id, excludedPropertyIds || []);
    store
      .recordActivity(req.account.id, req.user.id, "component_property_exclusions.update", {
        componentId: req.params.id,
        excludedCount: updated.length,
      })
      .catch(() => {});
    res.json({ componentId: req.params.id, excludedPropertyIds: updated });
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
          state,
          localeStatus,
          localeErrors,
        };
      }),
    });
  } catch (err) {
    res.status(502).json({ error: err.response?.data?.message || err.message });
  }
});

module.exports = router;
