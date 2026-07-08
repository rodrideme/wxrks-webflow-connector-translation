const express = require("express");
const store = require("../store");
const autoSyncQueue = require("../services/autoSyncQueue");
const autoSyncWebhook = require("../services/autoSyncWebhook");
const automationScheduler = require("../services/automationScheduler");

const router = express.Router();

function needsWebhook(automation) {
  return (
    automation.enabled &&
    !automation.archived &&
    (automation.contentScope.scope === "all" || (automation.contentScope.leaves || []).some((l) => l.kind === "collection"))
  );
}

/**
 * Registers/tears down the shared Webflow webhook based on whether any
 * enabled, non-archived automation includes CMS content. Called after every
 * mutation below -- both underlying calls are idempotent
 * (ensureWebhookRegistered lists existing webhooks first; teardownWebhook is
 * a no-op if nothing's registered), so calling this unconditionally is safe.
 */
async function syncWebhookRegistrationToAutomationsState() {
  const automations = await store.listAutomations();
  if (automations.some(needsWebhook)) {
    await autoSyncWebhook.ensureWebhookRegistered();
  } else {
    await autoSyncWebhook.teardownWebhook();
  }
}

/**
 * GET /api/automations
 * Lists every automation, enriched with its next scheduled run time and
 * the shared webhook's current health, for the Runs page.
 */
router.get("/", async (req, res) => {
  try {
    const [automations, settings] = await Promise.all([store.listAutomations(), store.getSettings()]);
    res.json({
      automations: automations.map((a) => ({
        ...a,
        nextFlushAt: a.enabled && !a.archived ? autoSyncQueue.nextFlushAt(a.cadence, settings.timezone) : null,
        pendingCount: autoSyncQueue.pendingCount(a.id),
      })),
      // Aggregated across every automation -- the Runs page shows one
      // unified pending queue rather than one per automation.
      pendingItems: autoSyncQueue.pendingItems(),
      webhook: settings.autoSyncWebhook,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/automations
 * body: { name, contentScope, cadence, workflows?, projectName?, includeExisting?, orgUnitOverride? }
 */
router.post("/", async (req, res) => {
  try {
    const { name, contentScope, cadence, workflows, projectName, includeExisting, orgUnitOverride } = req.body || {};
    if (!name || !contentScope) {
      return res.status(400).json({ error: "name and contentScope are required" });
    }
    const automation = await store.createAutomation({
      name,
      contentScope,
      cadence,
      workflows,
      projectName,
      includeExisting,
      orgUnitOverride,
    });
    await syncWebhookRegistrationToAutomationsState();
    res.json(automation);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * PUT /api/automations/:id
 * body: { name?, contentScope?, cadence?, workflows?, projectName?, includeExisting?, orgUnitOverride? }
 */
router.put("/:id", async (req, res) => {
  try {
    const { name, contentScope, cadence, workflows, projectName, includeExisting, orgUnitOverride } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (contentScope !== undefined) patch.contentScope = contentScope;
    if (cadence !== undefined) patch.cadence = cadence;
    if (workflows !== undefined) patch.workflows = workflows;
    if (projectName !== undefined) patch.projectName = projectName;
    if (includeExisting !== undefined) patch.includeExisting = includeExisting;
    if (orgUnitOverride !== undefined) patch.orgUnitOverride = orgUnitOverride;

    const automation = await store.updateAutomation(req.params.id, patch);
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    await syncWebhookRegistrationToAutomationsState();
    res.json(automation);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * DELETE /api/automations/:id
 */
router.delete("/:id", async (req, res) => {
  try {
    await store.deleteAutomation(req.params.id);
    await syncWebhookRegistrationToAutomationsState();
    res.json({ deleted: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post("/:id/pause", async (req, res) => {
  try {
    const automation = await store.updateAutomation(req.params.id, { enabled: false });
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    await syncWebhookRegistrationToAutomationsState();
    res.json(automation);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post("/:id/resume", async (req, res) => {
  try {
    const automation = await store.updateAutomation(req.params.id, { enabled: true });
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    await syncWebhookRegistrationToAutomationsState();
    res.json(automation);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/automations/:id/archive
 * POST /api/automations/:id/unarchive
 * Archived automations are permanently stopped (unlike paused, which is
 * meant to be temporary) but kept around for history/reference, matching
 * the design's 3-state model (Running/Paused/Archived).
 */
router.post("/:id/archive", async (req, res) => {
  try {
    const automation = await store.updateAutomation(req.params.id, { archived: true });
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    await syncWebhookRegistrationToAutomationsState();
    res.json(automation);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post("/:id/unarchive", async (req, res) => {
  try {
    const automation = await store.updateAutomation(req.params.id, { archived: false });
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    await syncWebhookRegistrationToAutomationsState();
    res.json(automation);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/automations/:id/flush
 * Manual "flush now" -- runs the same cycle the scheduled cadence triggers,
 * immediately, without waiting for the next scheduled time.
 */
router.post("/:id/flush", async (req, res) => {
  try {
    const automation = await store.getAutomation(req.params.id);
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    await automationScheduler.runAutomationCycle(automation);
    res.json({ flushed: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/automations/flush-all
 * The Runs page shows one unified pending queue across every automation
 * (matching the design) with a single "Translate queue now" action --
 * flushes each automation's own queue in turn rather than requiring the
 * user to flush them one at a time.
 */
router.post("/flush-all", async (req, res) => {
  try {
    const automations = await store.listAutomations();
    let itemsSynced = 0;
    for (const automation of automations) {
      if (autoSyncQueue.pendingCount(automation.id) === 0) continue;
      const result = await autoSyncQueue.flush(automation.id);
      itemsSynced += result.itemsSynced;
    }
    res.json({ flushed: true, itemsSynced });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/automations/:id/status
 * Live pending-queue detail for one automation's optional expand view.
 */
router.get("/:id/status", async (req, res) => {
  try {
    const automation = await store.getAutomation(req.params.id);
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    const settings = await store.getSettings();
    res.json({
      pendingCount: autoSyncQueue.pendingCount(automation.id),
      pendingSince: autoSyncQueue.pendingSince(automation.id),
      pendingItems: autoSyncQueue.pendingItems(automation.id),
      nextFlushAt: automation.enabled && !automation.archived ? autoSyncQueue.nextFlushAt(automation.cadence, settings.timezone) : null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
