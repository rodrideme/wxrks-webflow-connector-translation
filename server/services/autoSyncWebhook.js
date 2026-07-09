const crypto = require("crypto");
const webflow = require("./webflow");
const store = require("../store");

const TRIGGER_TYPE = "collection_item_published";
// Pages/Components have no per-entity webhook in Webflow's API -- this is
// the closest available signal (fires on any Designer publish action), used
// to trigger an immediate scan+enqueue for Pages/Components automations
// instead of waiting for their own cadence tick (see routes/webhooks.js and
// automationScheduler.scanAndEnqueueForPublishEvent).
const PAGES_TRIGGER_TYPE = "site_publish";

// Multi-user login (Phase 1): each account registers its own pair of
// webhooks at its own URL (encoding the account id in the path), the same
// pattern Stripe Connect/GitHub Apps use -- this is what lets
// routes/webhooks.js resolve an inbound delivery to the right account
// (and, for site_publish, is the *only* way to resolve it, since that
// payload carries no account-identifying field at all).
function webhookUrl(accountId, triggerType) {
  const appBaseUrl = process.env.APP_BASE_URL;
  if (!appBaseUrl) return null;
  const suffix = triggerType === PAGES_TRIGGER_TYPE ? "site-publish" : "cms-item-published";
  return `${appBaseUrl.replace(/\/$/, "")}/api/webhooks/webflow/${accountId}/${suffix}`;
}

/**
 * Registers (or confirms already-registered) one account's webhook, generic
 * over trigger type/settings-state so the CMS (`collection_item_published`)
 * and Pages/Components (`site_publish`) registrations -- two independent
 * Webflow webhook registrations per account, each with its own secretKey --
 * share one implementation. Lists existing webhooks first to avoid leaking
 * duplicate registrations across repeated create/delete/pause/resume calls
 * (Webflow caps registrations at 75 per trigger type per site).
 */
async function ensureRegistered(accountId, triggerType, updateState) {
  const url = webhookUrl(accountId, triggerType);
  if (!url) {
    await updateState({
      status: "error",
      lastError: "APP_BASE_URL is not configured -- cannot register a Webflow webhook without a public URL",
    });
    throw new Error("APP_BASE_URL is not configured");
  }

  const existing = await webflow.listWebhooks();
  const alreadyRegistered = existing.find((h) => h.triggerType === triggerType && h.url === url);
  if (alreadyRegistered) {
    await updateState({ webflowWebhookId: alreadyRegistered.id, status: "active", lastError: null });
    return alreadyRegistered;
  }

  try {
    const hook = await webflow.registerWebhook(triggerType, url);
    await updateState({
      webflowWebhookId: hook.id,
      signingSecret: hook.secretKey,
      registeredAt: new Date().toISOString(),
      status: "active",
      lastError: null,
    });
    return hook;
  } catch (err) {
    await updateState({ status: "error", lastError: err.message });
    throw err;
  }
}

/**
 * Deletes a registered webhook once no enabled automation needs it anymore.
 * Not calling this would leave a live webhook silently posting into a
 * feature the admin thinks is fully paused/deleted.
 */
async function teardown(webflowWebhookId, updateState) {
  if (webflowWebhookId) {
    try {
      await webflow.deleteWebhook(webflowWebhookId);
    } catch (err) {
      // Already gone or otherwise unreachable -- clear our record regardless,
      // there's nothing useful left to retry.
      console.error(`Failed to delete Webflow webhook ${webflowWebhookId}:`, err.message);
    }
  }
  await updateState({ webflowWebhookId: null, signingSecret: null, registeredAt: null, status: "not_registered", lastError: null });
}

async function ensureWebhookRegistered(accountId) {
  return ensureRegistered(accountId, TRIGGER_TYPE, (patch) => store.updateAutoSyncWebhookState(accountId, patch));
}

async function teardownWebhook(accountId) {
  const settings = await store.getSettings(accountId);
  return teardown(settings.autoSyncWebhook.webflowWebhookId, (patch) => store.updateAutoSyncWebhookState(accountId, patch));
}

async function ensurePagesWebhookRegistered(accountId) {
  return ensureRegistered(accountId, PAGES_TRIGGER_TYPE, (patch) => store.updateSitePublishWebhookState(accountId, patch));
}

async function teardownPagesWebhook(accountId) {
  const settings = await store.getSettings(accountId);
  return teardown(settings.sitePublishWebhook.webflowWebhookId, (patch) => store.updateSitePublishWebhookState(accountId, patch));
}

/**
 * Verifies x-webflow-signature (HMAC-SHA256 of `${timestamp}:${rawBody}`)
 * and rejects requests outside a 5-minute timestamp window (replay
 * protection), per Webflow's documented webhook verification guidance.
 * Requires the raw request body buffer (see index.js's express.json verify
 * option) since the signature is computed over the exact bytes received,
 * not a re-serialized version of the parsed JSON.
 */
function verifySignature({ rawBody, signature, timestamp, signingSecret }) {
  if (!signingSecret || !signature || !timestamp || !rawBody) return false;

  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || age < 0 || age > 5 * 60 * 1000) return false;

  const expected = crypto
    .createHmac("sha256", signingSecret)
    .update(`${timestamp}:${rawBody}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

module.exports = {
  ensureWebhookRegistered,
  teardownWebhook,
  ensurePagesWebhookRegistered,
  teardownPagesWebhook,
  verifySignature,
  TRIGGER_TYPE,
  PAGES_TRIGGER_TYPE,
};
