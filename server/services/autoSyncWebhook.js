const crypto = require("crypto");
const webflow = require("./webflow");
const store = require("../store");

const TRIGGER_TYPE = "collection_item_published";
const WEBHOOK_PATH = "/api/webhooks/webflow";

/**
 * Registers (or confirms already-registered) the Webflow webhook Auto Sync
 * relies on. Called when settings.autoSync.enabled transitions false->true,
 * and as a startup self-heal check if enabled but never successfully
 * registered (e.g. a prior attempt crashed, or APP_BASE_URL wasn't set yet).
 * Lists existing webhooks first to avoid leaking duplicate registrations
 * across repeated enable/disable toggling (Webflow caps registrations at 75
 * per trigger type per site).
 */
async function ensureWebhookRegistered() {
  const appBaseUrl = process.env.APP_BASE_URL;
  if (!appBaseUrl) {
    await store.updateAutoSyncWebhookState({
      status: "error",
      lastError: "APP_BASE_URL is not configured -- cannot register a Webflow webhook without a public URL",
    });
    throw new Error("APP_BASE_URL is not configured");
  }
  const url = `${appBaseUrl.replace(/\/$/, "")}${WEBHOOK_PATH}`;

  const existing = await webflow.listWebhooks();
  const alreadyRegistered = existing.find((h) => h.triggerType === TRIGGER_TYPE && h.url === url);
  if (alreadyRegistered) {
    await store.updateAutoSyncWebhookState({
      webflowWebhookId: alreadyRegistered.id,
      status: "active",
      lastError: null,
    });
    return alreadyRegistered;
  }

  try {
    const hook = await webflow.registerWebhook(TRIGGER_TYPE, url);
    await store.updateAutoSyncWebhookState({
      webflowWebhookId: hook.id,
      signingSecret: hook.secretKey,
      registeredAt: new Date().toISOString(),
      status: "active",
      lastError: null,
    });
    return hook;
  } catch (err) {
    await store.updateAutoSyncWebhookState({ status: "error", lastError: err.message });
    throw err;
  }
}

/**
 * Deletes the registered webhook on settings.autoSync.enabled true->false.
 * Not calling this on disable would leave a live webhook silently posting
 * into a feature the admin thinks is off.
 */
async function teardownWebhook() {
  const settings = await store.getSettings();
  const { webflowWebhookId } = settings.autoSync.webhook;
  if (webflowWebhookId) {
    try {
      await webflow.deleteWebhook(webflowWebhookId);
    } catch (err) {
      // Already gone or otherwise unreachable -- clear our record regardless,
      // there's nothing useful left to retry.
      console.error(`Failed to delete Webflow webhook ${webflowWebhookId}:`, err.message);
    }
  }
  await store.updateAutoSyncWebhookState({
    webflowWebhookId: null,
    signingSecret: null,
    registeredAt: null,
    status: "not_registered",
    lastError: null,
  });
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

module.exports = { ensureWebhookRegistered, teardownWebhook, verifySignature, TRIGGER_TYPE };
