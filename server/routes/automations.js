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

function needsPagesWebhook(automation) {
  return (
    automation.enabled &&
    !automation.archived &&
    (automation.contentScope.scope === "all" ||
      (automation.contentScope.leaves || []).some((l) => l.kind === "pagesFolder" || l.kind === "components"))
  );
}

/**
 * Registers/tears down this account's two Webflow webhooks (CMS and,
 * separately, Pages/Components' site_publish) based on whether any of ITS
 * enabled, non-archived automations need each. Called after every mutation
 * below -- all four underlying calls are idempotent (ensure* lists existing
 * webhooks first; teardown* is a no-op if nothing's registered), so calling
 * this unconditionally is safe.
 */
async function syncWebhookRegistrationToAutomationsState(accountId) {
  const automations = await store.listAutomations(accountId);

  // Each awaited independently -- one webhook's registration failing (e.g.
  // APP_BASE_URL unset locally) must not prevent the other from being
  // attempted.
  try {
    if (automations.some(needsWebhook)) {
      await autoSyncWebhook.ensureWebhookRegistered(accountId);
    } else {
      await autoSyncWebhook.teardownWebhook(accountId);
    }
  } catch (err) {
    console.error("CMS webhook registration sync failed:", err.message);
  }

  try {
    if (automations.some(needsPagesWebhook)) {
      await autoSyncWebhook.ensurePagesWebhookRegistered(accountId);
    } else {
      await autoSyncWebhook.teardownPagesWebhook(accountId);
    }
  } catch (err) {
    console.error("Pages webhook registration sync failed:", err.message);
  }
}

/**
 * GET /api/automations
 * Lists every automation, enriched with its next scheduled run time and
 * the shared webhook's current health, for the Runs page.
 */
router.get("/", async (req, res) => {
  try {
    const accountId = req.account.id;
    const [automations, settings] = await Promise.all([store.listAutomations(accountId), store.getSettings(accountId)]);
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
      pagesWebhook: settings.sitePublishWebhook,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/automations
 * body: { name, contentScope, cadence, workflows?, projectName?, includeExisting?, orgUnitOverride?, targetLocalesOverride? }
 */
router.post("/", async (req, res) => {
  try {
    const accountId = req.account.id;
    const { name, contentScope, cadence, workflows, projectName, includeExisting, orgUnitOverride, targetLocalesOverride } = req.body || {};
    if (!name || !contentScope) {
      return res.status(400).json({ error: "name and contentScope are required" });
    }
    const automation = await store.createAutomation(accountId, {
      name,
      contentScope,
      cadence,
      workflows,
      projectName,
      includeExisting,
      orgUnitOverride,
      targetLocalesOverride,
    });

    // Backfill currently-matching content right away rather than waiting for
    // this automation's own cadence tick (up to a day away) or the hourly
    // CMS reconciliation safety net. Neither the scan nor the actual wxrks
    // upload is awaited here -- both run in the background after this
    // responds; startFirstSyncJob creates the job synchronously and hands
    // back a jobId to poll immediately (see its own docstring for why:
    // scanning "All content" can mean 100+ individual Webflow calls with no
    // bulk endpoint available, which used to block this whole response).
    let firstSyncJob = null;
    if (automation.includeExisting) {
      firstSyncJob = automationScheduler.startFirstSyncJob(automation);
    }

    // Best-effort: the automation is already saved at this point, and a
    // failed (re)registration is already surfaced persistently via the
    // Runs page's webhook status pill -- it shouldn't turn a successful
    // creation into an error response (and, before this fix, threw before
    // the includeExisting backfill above ever got a chance to run).
    try {
      await syncWebhookRegistrationToAutomationsState(accountId);
    } catch (err) {
      console.error("Webhook registration sync failed after creating automation:", err.message);
    }

    res.json({ ...automation, firstSyncJob });
  } catch (err) {
    if (err.code === "WXRKS_NOT_CONNECTED") {
      return res.status(409).json({ error: err.message, code: "wxrks_not_connected" });
    }
    res.status(502).json({ error: err.message });
  }
});

/**
 * PUT /api/automations/:id
 * body: { name?, contentScope?, cadence?, workflows?, projectName?, includeExisting?, orgUnitOverride?, targetLocalesOverride? }
 */
router.put("/:id", async (req, res) => {
  try {
    const accountId = req.account.id;
    const { name, contentScope, cadence, workflows, projectName, includeExisting, orgUnitOverride, targetLocalesOverride } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (contentScope !== undefined) patch.contentScope = contentScope;
    if (cadence !== undefined) patch.cadence = cadence;
    if (workflows !== undefined) patch.workflows = workflows;
    if (projectName !== undefined) patch.projectName = projectName;
    if (includeExisting !== undefined) patch.includeExisting = includeExisting;
    if (orgUnitOverride !== undefined) patch.orgUnitOverride = orgUnitOverride;
    if (targetLocalesOverride !== undefined) patch.targetLocalesOverride = targetLocalesOverride;

    const automation = await store.updateAutomation(accountId, req.params.id, patch);
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    try {
      await syncWebhookRegistrationToAutomationsState(accountId);
    } catch (err) {
      console.error("Webhook registration sync failed after updating automation:", err.message);
    }
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
    const accountId = req.account.id;
    await store.deleteAutomation(accountId, req.params.id);
    await syncWebhookRegistrationToAutomationsState(accountId);
    res.json({ deleted: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post("/:id/pause", async (req, res) => {
  try {
    const accountId = req.account.id;
    const automation = await store.updateAutomation(accountId, req.params.id, { enabled: false });
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    await syncWebhookRegistrationToAutomationsState(accountId);
    res.json(automation);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post("/:id/resume", async (req, res) => {
  try {
    const accountId = req.account.id;
    const automation = await store.updateAutomation(accountId, req.params.id, { enabled: true });
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    await syncWebhookRegistrationToAutomationsState(accountId);
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
    const accountId = req.account.id;
    const automation = await store.updateAutomation(accountId, req.params.id, { archived: true });
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    await syncWebhookRegistrationToAutomationsState(accountId);
    res.json(automation);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post("/:id/unarchive", async (req, res) => {
  try {
    const accountId = req.account.id;
    const automation = await store.updateAutomation(accountId, req.params.id, { archived: false });
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    await syncWebhookRegistrationToAutomationsState(accountId);
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
    const automation = await store.getAutomation(req.account.id, req.params.id);
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    await automationScheduler.runAutomationCycle(automation);
    res.json({ flushed: true });
  } catch (err) {
    if (err.code === "WXRKS_NOT_CONNECTED") {
      return res.status(409).json({ error: err.message, code: "wxrks_not_connected" });
    }
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
    const automations = await store.listAutomations(req.account.id);
    let itemsSynced = 0;
    for (const automation of automations) {
      if (autoSyncQueue.pendingCount(automation.id) === 0) continue;
      const result = await autoSyncQueue.flush(automation.id);
      itemsSynced += result.itemsSynced;
    }
    res.json({ flushed: true, itemsSynced });
  } catch (err) {
    if (err.code === "WXRKS_NOT_CONNECTED") {
      return res.status(409).json({ error: err.message, code: "wxrks_not_connected" });
    }
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/automations/:id/status
 * Live pending-queue detail for one automation's optional expand view.
 */
router.get("/:id/status", async (req, res) => {
  try {
    const accountId = req.account.id;
    const automation = await store.getAutomation(accountId, req.params.id);
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    const settings = await store.getSettings(accountId);
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
