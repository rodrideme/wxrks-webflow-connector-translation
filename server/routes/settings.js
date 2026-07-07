const express = require("express");
const store = require("../store");
const autoSyncWebhook = require("../services/autoSyncWebhook");
const autoSyncQueue = require("../services/autoSyncQueue");
const autoSyncReconciliation = require("../services/autoSyncReconciliation");

const router = express.Router();

function mask(value) {
  if (!value) return "";
  return value.length <= 4 ? "****" : `${value.slice(0, 2)}${"*".repeat(value.length - 4)}${value.slice(-2)}`;
}

/**
 * GET /api/settings
 * Runtime settings (source/target locales, auto-publish) plus a masked view
 * of the env-configured connection details.
 */
router.get("/", async (req, res) => {
  try {
    const settings = await store.getSettings();
    res.json({
      ...settings,
      env: {
        WEBFLOW_SITE_ID: process.env.WEBFLOW_SITE_ID || "",
        WEBFLOW_API_TOKEN: mask(process.env.WEBFLOW_API_TOKEN),
        WXRKS_API_URL: process.env.WXRKS_API_URL || "",
        WXRKS_API_TOKEN: mask(process.env.WXRKS_API_TOKEN),
        WXRKS_ACCESS_KEY: mask(process.env.WXRKS_ACCESS_KEY),
        WXRKS_SECRET: mask(process.env.WXRKS_SECRET),
        WXRKS_ORG_UNIT_UUID: process.env.WXRKS_ORG_UNIT_UUID || "",
        APP_BASE_URL: process.env.APP_BASE_URL || "",
      },
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * PUT /api/settings
 * body: { sourceLocale?, targetLocales?, autoPublish?, autoApprove?, orgUnitUUID?, enabledCollectionIds?, autoSync? }
 * Env-backed connection secrets are not editable here — they're deploy-time config.
 *
 * `autoSync` is sent as a full object by the client (same pattern as the
 * rest of settings) but its `webhook` sub-object is server-owned bookkeeping
 * (see store.updateAutoSyncWebhookState) -- it's intentionally NOT
 * overwritten here even if the client's copy is stale, since background
 * webhook lifecycle code can update it concurrently with a settings save.
 */
router.put("/", async (req, res) => {
  const {
    sourceLocale,
    targetLocales,
    autoPublish,
    autoApprove,
    orgUnitUUID,
    allCollectionsEnabled,
    enabledCollectionIds,
    workUnitNamePattern,
    timezone,
    autoSync,
    pages,
    pagesWorkUnitNamePattern,
  } = req.body || {};
  const patch = {};
  if (sourceLocale !== undefined) patch.sourceLocale = sourceLocale;
  if (targetLocales !== undefined) patch.targetLocales = targetLocales;
  if (autoPublish !== undefined) patch.autoPublish = autoPublish;
  if (autoApprove !== undefined) patch.autoApprove = autoApprove;
  if (orgUnitUUID !== undefined) patch.orgUnitUUID = orgUnitUUID;
  if (allCollectionsEnabled !== undefined) patch.allCollectionsEnabled = allCollectionsEnabled;
  if (enabledCollectionIds !== undefined) patch.enabledCollectionIds = enabledCollectionIds;
  if (workUnitNamePattern !== undefined) patch.workUnitNamePattern = workUnitNamePattern;
  if (timezone !== undefined) patch.timezone = timezone;
  if (pages !== undefined) patch.pages = pages;
  if (pagesWorkUnitNamePattern !== undefined) patch.pagesWorkUnitNamePattern = pagesWorkUnitNamePattern;

  try {
    const before = await store.getSettings();

    if (autoSync !== undefined) {
      // Never let a client PUT clobber the server-owned webhook bookkeeping.
      patch.autoSync = { ...autoSync, webhook: before.autoSync.webhook };
    }

    const updated = await store.updateSettings(patch);

    const scheduleChanged =
      JSON.stringify(before.autoSync.flushTimes) !== JSON.stringify(updated.autoSync.flushTimes) ||
      before.timezone !== updated.timezone;

    if (autoSync !== undefined) {
      const wasEnabled = before.autoSync.enabled;
      const nowEnabled = updated.autoSync.enabled;

      if (!wasEnabled && nowEnabled) {
        await autoSyncWebhook.ensureWebhookRegistered();
        autoSyncQueue.startFlushLoop(updated.autoSync.flushTimes, updated.timezone);
        autoSyncReconciliation.startReconciliationLoop();
      } else if (wasEnabled && !nowEnabled) {
        await autoSyncWebhook.teardownWebhook();
        autoSyncQueue.stopFlushLoop();
        autoSyncReconciliation.stopReconciliationLoop();
      } else if (nowEnabled && scheduleChanged) {
        // Flush-schedule or timezone edit takes effect immediately, no restart needed.
        autoSyncQueue.startFlushLoop(updated.autoSync.flushTimes, updated.timezone);
      }
    } else if (updated.autoSync.enabled && scheduleChanged) {
      // Timezone changed via a PUT that didn't touch autoSync itself.
      autoSyncQueue.startFlushLoop(updated.autoSync.flushTimes, updated.timezone);
    }

    res.json(await store.getSettings()); // re-fetch: webhook state may have changed above
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/settings/autosync/reregister-webhook
 * Manual recovery action for the Sync Panel's Auto Sync tab, surfaced when
 * reconciliation infers the Webflow webhook was silently deactivated.
 * Deliberately not automatic (see autoSyncReconciliation.js) -- a
 * repeatedly-failing target URL re-registering itself in a loop is worse
 * than surfacing the problem once and letting a human confirm the URL is
 * reachable before retrying.
 */
router.post("/autosync/reregister-webhook", async (req, res) => {
  try {
    await autoSyncWebhook.ensureWebhookRegistered();
    res.json(await store.getSettings());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
