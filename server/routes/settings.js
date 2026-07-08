const express = require("express");
const store = require("../store");
const autoSyncWebhook = require("../services/autoSyncWebhook");

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
 * body: { sourceLocale?, targetLocales?, autoPublish?, autoApprove?, orgUnitUUID?, enabledCollectionIds?, pages?, components? }
 * Env-backed connection secrets are not editable here — they're deploy-time
 * config. Automation config (schedule, content scope, org-unit override)
 * lives in the `automations` table now -- see routes/automations.js, not
 * this endpoint.
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
    pages,
    pagesWorkUnitNamePattern,
    components,
    componentsWorkUnitNamePattern,
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
  if (components !== undefined) patch.components = components;
  if (componentsWorkUnitNamePattern !== undefined) patch.componentsWorkUnitNamePattern = componentsWorkUnitNamePattern;

  try {
    await store.updateSettings(patch);
    res.json(await store.getSettings());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/settings/autosync/reregister-webhook
 * Manual recovery action, surfaced on the Automation list page when
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
