/**
 * CMS Automation's safety net. Runs on a fixed interval (default hourly,
 * independent of any automation's flush schedule) and re-scans Webflow for
 * anything that qualifies under an enabled cms/all automation but was
 * published since that automation's last checkpoint and hasn't already been
 * synced -- catches items the live webhook missed (delivery failure, or
 * Webflow silently deactivating the webhook after repeated failed attempts).
 *
 * Pages/Components need no safety net of this kind -- their scheduled poll
 * (automationScheduler.js) IS the primary mechanism and is always fully
 * current as of each cycle, so there's nothing for a safety net to catch.
 *
 * Cutoff-based per automation, not "only look at the last hour": this job
 * may not actually fire on a strict hourly cadence (e.g. on Render's free
 * tier the service can spin down when idle and this in-memory timer dies
 * with it), so each pass compares "now" against each automation's own
 * persisted checkpoint and processes the *entire* gap, however long it's
 * been, rather than assuming a fixed window.
 */

const webflow = require("./webflow");
const store = require("../store");
const autoSyncQueue = require("./autoSyncQueue");

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

async function reconcileAutomation(automation, allCollections) {
  const settings = await store.getSettings();
  const cutoff = automation.checkpoint.lastCheckpoint
    ? new Date(automation.checkpoint.lastCheckpoint)
    : new Date(Date.now() - FIRST_RUN_LOOKBACK_MS);
  const nextCheckpoint = new Date();

  const relevantCollections =
    automation.contentScope.type === "all"
      ? allCollections
      : allCollections.filter(
          (c) =>
            automation.contentScope.allCollectionsEnabled ||
            automation.contentScope.enabledCollectionIds.includes(c.id)
        );

  let missedCount = 0;
  for (const collection of relevantCollections) {
    const items = await webflow.listAllItems(collection.id, { locale: settings.sourceLocale });
    for (const item of items) {
      if (!item.lastPublished || new Date(item.lastPublished) < cutoff) continue;
      if (!store.isAutomationCmsItemQualified(automation, collection, item)) continue;
      if (store.isAutomationItemAlreadySynced(automation, collection.id, item.id, item.lastPublished)) continue;

      autoSyncQueue.enqueue({ automation, collection, item });
      missedCount += 1;
    }
  }

  await store.advanceAutomationCheckpoint(automation.id, nextCheckpoint.toISOString());
  return missedCount;
}

async function reconcile() {
  const automations = await store.listAutomations();
  const relevantAutomations = automations.filter(
    (a) => a.enabled && (a.contentScope.type === "cms" || a.contentScope.type === "all")
  );
  if (relevantAutomations.length === 0) return;

  const allCollections = await webflow.listCollections();
  const settings = await store.getSettings();
  const cutoffForWebhookCheck = new Date(Date.now() - DEFAULT_INTERVAL_MS * 2);

  let totalMissed = 0;
  for (const automation of relevantAutomations) {
    totalMissed += await reconcileAutomation(automation, allCollections);
  }

  // Webhook-deactivation inference: only flip status if reconciliation
  // actually found real misses AND the webhook looked idle over the same
  // window -- a quiet window with genuinely zero publishes must not be
  // mistaken for a dead webhook.
  const { autoSyncWebhook } = settings;
  const webhookIdleTooLong = !autoSyncWebhook.lastEventAt || new Date(autoSyncWebhook.lastEventAt) < cutoffForWebhookCheck;
  if (totalMissed > 0 && webhookIdleTooLong && autoSyncWebhook.status === "active") {
    await store.updateAutoSyncWebhookState({ status: "deactivated" });
  }
}

let reconciliationTimer = null;

function startReconciliationLoop(intervalMs = DEFAULT_INTERVAL_MS) {
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  reconciliationTimer = setInterval(() => {
    reconcile().catch((err) => console.error("Automation reconciliation failed:", err.message));
  }, intervalMs);
}

function stopReconciliationLoop() {
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  reconciliationTimer = null;
}

module.exports = { reconcile, startReconciliationLoop, stopReconciliationLoop };
