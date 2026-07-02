/**
 * Auto Sync's safety net. Runs on a fixed interval (default hourly,
 * independent of the flush schedule) and re-scans Webflow for anything that
 * qualifies under the current Auto Sync rules but was published since the
 * last checkpoint and hasn't already been synced -- catches items the live
 * webhook missed (delivery failure, or Webflow silently deactivating the
 * webhook after 3 failed attempts).
 *
 * Cutoff-based, not "only look at the last hour": this job may not actually
 * fire on a strict hourly cadence (e.g. on Render's free tier the service
 * can spin down when idle and this in-memory timer dies with it), so each
 * pass compares "now" against the persisted checkpoint and processes the
 * *entire* gap, however long it's been, rather than assuming a fixed window.
 */

const webflow = require("./webflow");
const store = require("../store");
const autoSyncQueue = require("./autoSyncQueue");
const { evaluateAutoSyncRules } = require("./autoSyncRules");

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

async function reconcile() {
  const settings = await store.getSettings();
  if (!settings.autoSync.enabled) return;

  const cutoff = settings.autoSyncReconciliation.lastCheckpoint
    ? new Date(settings.autoSyncReconciliation.lastCheckpoint)
    : new Date(Date.now() - FIRST_RUN_LOOKBACK_MS);
  // Captured before scanning so items published mid-scan are picked up on
  // the *next* pass, not skipped.
  const nextCheckpoint = new Date();

  const allCollections = await webflow.listCollections();
  const relevantCollections = allCollections.filter(
    (c) => settings.autoSync.allCollectionsEnabled || settings.autoSync.enabledCollectionIds.includes(c.id)
  );

  let missedCount = 0;
  for (const collection of relevantCollections) {
    const items = await webflow.listAllItems(collection.id, { locale: settings.sourceLocale });
    for (const item of items) {
      if (!item.lastPublished || new Date(item.lastPublished) < cutoff) continue;
      if (!evaluateAutoSyncRules(settings, collection, item)) continue;
      if (store.isAlreadyAutoSynced(settings, collection.id, item.id, item.lastPublished)) continue;

      autoSyncQueue.enqueue({ collection, item });
      missedCount += 1;
    }
  }

  // Webhook-deactivation inference: only flip status if reconciliation
  // actually found real misses AND the webhook looked idle over the same
  // window -- a quiet window with genuinely zero publishes must not be
  // mistaken for a dead webhook.
  const { webhook } = settings.autoSync;
  const webhookIdleTooLong = !webhook.lastEventAt || new Date(webhook.lastEventAt) < cutoff;
  if (missedCount > 0 && webhookIdleTooLong && webhook.status === "active") {
    await store.updateAutoSyncWebhookState({ status: "deactivated" });
  }

  await store.updateSettings({
    autoSyncReconciliation: { ...settings.autoSyncReconciliation, lastCheckpoint: nextCheckpoint.toISOString() },
  });
}

let reconciliationTimer = null;

function startReconciliationLoop(intervalMs = DEFAULT_INTERVAL_MS) {
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  reconciliationTimer = setInterval(() => {
    reconcile().catch((err) => console.error("Auto Sync reconciliation failed:", err.message));
  }, intervalMs);
}

function stopReconciliationLoop() {
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  reconciliationTimer = null;
}

module.exports = { reconcile, startReconciliationLoop, stopReconciliationLoop };
