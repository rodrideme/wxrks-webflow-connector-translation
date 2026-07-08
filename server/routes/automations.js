const express = require("express");
const store = require("../store");
const autoSyncQueue = require("../services/autoSyncQueue");
const autoSyncWebhook = require("../services/autoSyncWebhook");
const automationScheduler = require("../services/automationScheduler");

const router = express.Router();

/**
 * Registers/tears down the shared Webflow webhook based on whether any
 * enabled cms/all automation exists. Called after every mutation below --
 * both underlying calls are idempotent (ensureWebhookRegistered lists
 * existing webhooks first; teardownWebhook is a no-op if nothing's
 * registered), so calling this unconditionally is safe.
 */
async function syncWebhookRegistrationToAutomationsState() {
  const automations = await store.listAutomations();
  const anyNeedsWebhook = automations.some((a) => a.enabled && (a.contentScope.type === "all" || a.contentScope.type === "cms"));
  if (anyNeedsWebhook) {
    await autoSyncWebhook.ensureWebhookRegistered();
  } else {
    await autoSyncWebhook.teardownWebhook();
  }
}

/**
 * GET /api/automations
 * Lists every automation, enriched with its next scheduled flush time and
 * the shared webhook's current health, for the Automation list page.
 */
router.get("/", async (req, res) => {
  try {
    const [automations, settings] = await Promise.all([store.listAutomations(), store.getSettings()]);
    res.json({
      automations: automations.map((a) => ({
        ...a,
        nextFlushAt: a.enabled ? autoSyncQueue.nextFlushAt(a.flushTimes, settings.timezone) : null,
        pendingCount: autoSyncQueue.pendingCount(a.id),
      })),
      webhook: settings.autoSyncWebhook,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/automations
 * body: { name, contentScope, flushTimes, orgUnitOverride? }
 */
router.post("/", async (req, res) => {
  try {
    const { name, contentScope, flushTimes, orgUnitOverride } = req.body || {};
    if (!name || !contentScope) {
      return res.status(400).json({ error: "name and contentScope are required" });
    }
    const automation = await store.createAutomation({ name, contentScope, flushTimes, orgUnitOverride });
    await syncWebhookRegistrationToAutomationsState();
    res.json(automation);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * PUT /api/automations/:id
 * body: { name?, contentScope?, flushTimes?, orgUnitOverride? }
 */
router.put("/:id", async (req, res) => {
  try {
    const { name, contentScope, flushTimes, orgUnitOverride } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (contentScope !== undefined) patch.contentScope = contentScope;
    if (flushTimes !== undefined) patch.flushTimes = flushTimes;
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
 * POST /api/automations/:id/flush
 * Manual "flush now" -- runs the same cycle the scheduled times trigger,
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
      nextFlushAt: automation.enabled ? autoSyncQueue.nextFlushAt(automation.flushTimes, settings.timezone) : null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
