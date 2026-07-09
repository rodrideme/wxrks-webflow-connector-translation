const express = require("express");
const store = require("../store");
const wxrks = require("../services/wxrks");
const autoSyncWebhook = require("../services/autoSyncWebhook");
const transliterationLlm = require("../services/transliterationLlm");

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
    const settings = await store.getSettings(req.account.id);
    const account = await store.getAccount(req.account.id);
    const wxrksConnection = await store.getWxrksConnection(req.account.id);
    const llmConnection = await store.getLlmConnection(req.account.id);
    const isOriginalAccount = account?.webflowSiteId && account.webflowSiteId === process.env.WEBFLOW_SITE_ID;
    res.json({
      ...settings,
      wxrksConnected: Boolean(wxrksConnection) || isOriginalAccount,
      wxrksAccessKeyMasked: wxrksConnection ? mask(wxrksConnection.accessKey) : isOriginalAccount ? mask(process.env.WXRKS_ACCESS_KEY) : "",
      llmConnected: Boolean(llmConnection),
      llmApiKeyMasked: llmConnection ? mask(llmConnection.apiKey) : "",
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
 * body: { sourceLocale?, targetLocales?, autoPublish?, autoApprove?, orgUnitUUID?, workUnitNamePattern?, timezone?, pagesWorkUnitNamePattern?, componentsWorkUnitNamePattern?, slugHandling? }
 * Env-backed connection secrets are not editable here — they're deploy-time
 * config. Automation config (schedule, content scope, org-unit/target-locale
 * override) lives in the `automations` table now -- see routes/automations.js,
 * not this endpoint. targetLocales/orgUnitUUID have no dedicated editing UI
 * anymore (the wizard sends its own per-send/per-automation values) but stay
 * accepted here as the frozen fallback default for pre-existing automations
 * and direct API use.
 */
router.put("/", async (req, res) => {
  const {
    sourceLocale,
    targetLocales,
    autoPublish,
    autoApprove,
    orgUnitUUID,
    workUnitNamePattern,
    timezone,
    pagesWorkUnitNamePattern,
    componentsWorkUnitNamePattern,
    slugHandling,
  } = req.body || {};
  const patch = {};
  if (sourceLocale !== undefined) patch.sourceLocale = sourceLocale;
  if (targetLocales !== undefined) patch.targetLocales = targetLocales;
  if (autoPublish !== undefined) patch.autoPublish = autoPublish;
  if (autoApprove !== undefined) patch.autoApprove = autoApprove;
  if (orgUnitUUID !== undefined) patch.orgUnitUUID = orgUnitUUID;
  if (workUnitNamePattern !== undefined) patch.workUnitNamePattern = workUnitNamePattern;
  if (timezone !== undefined) patch.timezone = timezone;
  if (pagesWorkUnitNamePattern !== undefined) patch.pagesWorkUnitNamePattern = pagesWorkUnitNamePattern;
  if (componentsWorkUnitNamePattern !== undefined) patch.componentsWorkUnitNamePattern = componentsWorkUnitNamePattern;

  try {
    if (slugHandling !== undefined) {
      const current = await store.getSettings(req.account.id);
      patch.slugHandling = {
        ...current.slugHandling,
        ...(["source", "translate", "transliterate"].includes(slugHandling.mode) ? { mode: slugHandling.mode } : {}),
        ...(Number.isFinite(slugHandling.maxLength) ? { maxLength: Math.min(200, Math.max(20, Math.round(slugHandling.maxLength))) } : {}),
      };
    }
    await store.updateSettings(req.account.id, patch);
    res.json(await store.getSettings(req.account.id));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * PUT /api/settings/wxrks-connection
 * body: { accessKey, secret }
 * Validates the credentials against wxrks's real /auth endpoint before
 * ever storing them -- an invalid accessKey/secret pair should never be
 * silently saved, only to fail confusingly on the next real send.
 */
router.put("/wxrks-connection", async (req, res) => {
  const { accessKey, secret } = req.body || {};
  if (!accessKey || !secret) {
    return res.status(400).json({ error: "accessKey and secret are required" });
  }
  try {
    await wxrks.testCredentials(accessKey, secret);
  } catch (err) {
    return res.status(400).json({ error: err.response?.data?.message || err.message || "Invalid wxrks credentials" });
  }
  try {
    await store.upsertWxrksConnection(req.account.id, { accessKey, secret, connectedByUserId: req.user.id });
    res.json({ connected: true, accessKeyMasked: mask(accessKey) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * DELETE /api/settings/wxrks-connection
 * Disconnects this account's own wxrks credentials.
 */
router.delete("/wxrks-connection", async (req, res) => {
  try {
    await store.deleteWxrksConnection(req.account.id);
    res.json({ connected: false });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * PUT /api/settings/llm-connection
 * body: { apiKey }
 * Optional, only used as a fallback for slugHandling's "transliterate" mode
 * on scripts the built-in Cyrillic/Greek map can't handle (see
 * services/transliterationLlm.js). Validated against Anthropic's real API
 * before saving, same reasoning as the wxrks connection above.
 */
router.put("/llm-connection", async (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey) {
    return res.status(400).json({ error: "apiKey is required" });
  }
  try {
    await transliterationLlm.testApiKey(apiKey);
  } catch (err) {
    return res.status(400).json({ error: err.response?.data?.error?.message || err.message || "Invalid API key" });
  }
  try {
    await store.upsertLlmConnection(req.account.id, { apiKey, connectedByUserId: req.user.id });
    res.json({ connected: true, apiKeyMasked: mask(apiKey) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * DELETE /api/settings/llm-connection
 */
router.delete("/llm-connection", async (req, res) => {
  try {
    await store.deleteLlmConnection(req.account.id);
    res.json({ connected: false });
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
    await autoSyncWebhook.ensureWebhookRegistered(req.account.id);
    res.json(await store.getSettings(req.account.id));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/settings/autosync/reregister-pages-webhook
 * Same manual recovery action as above, for the Pages/Components
 * site_publish webhook.
 */
router.post("/autosync/reregister-pages-webhook", async (req, res) => {
  try {
    await autoSyncWebhook.ensurePagesWebhookRegistered(req.account.id);
    res.json(await store.getSettings(req.account.id));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
