/**
 * Auto Sync's debounce/batch queue. Qualifying published items accumulate
 * here (in-memory, matching the existing non-persisted syncJobs pattern in
 * store.js) and get flushed into a single shared wxrks project on a fixed
 * interval -- NOT a sliding/resetting debounce, so latency stays bounded
 * even during a burst of edits. Default cadence is 2 flushes/day
 * (user-configurable via settings.autoSync.flushesPerDay), reflecting the
 * user's explicit choice of a coarse schedule over near-real-time syncing.
 *
 * If the process restarts before a flush, queued-but-unflushed items are
 * lost -- acceptable, since the reconciliation safety net
 * (autoSyncReconciliation.js) re-scans for anything published since the
 * last checkpoint and re-enqueues it on its own schedule regardless.
 */

const store = require("../store");
const wxrks = require("../services/wxrks");
const { syncItemIntoBatch, requestBatchApproval } = require("./syncCore");

// Map keyed by `${collectionId}:${itemId}` -> { collection, item, enqueuedAt }.
// Re-enqueuing the same key before the next flush overwrites rather than
// duplicates -- a rapid publish->unpublish->publish within one window still
// results in exactly one sync of that item, using its latest state at flush
// time.
const pending = new Map();
let flushTimer = null;
let lastFlushAt = null;

function enqueue({ collection, item }) {
  pending.set(`${collection.id}:${item.id}`, { collection, item, enqueuedAt: new Date().toISOString() });
}

function startFlushLoop(flushesPerDay) {
  if (flushTimer) clearInterval(flushTimer);
  const intervalMs = (24 / flushesPerDay) * 60 * 60 * 1000;
  flushTimer = setInterval(() => {
    flush().catch((err) => console.error("Auto Sync flush failed:", err.message));
  }, intervalMs);
}

function stopFlushLoop() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
}

async function flush() {
  lastFlushAt = new Date().toISOString();
  if (pending.size === 0) return;

  const batch = [...pending.values()];
  // Clear before awaiting so new webhook events arriving during the flush go
  // into the *next* window, not lost or double-counted.
  pending.clear();

  const settings = await store.getSettings();
  const { sourceLocale, targetLocales, orgUnitUUID: settingsOrgUnitUUID, autoApprove, workUnitNamePattern } =
    settings;
  if (targetLocales.length === 0) return; // nothing configured to translate into -- same guard as bulk/item

  const orgUnitUUID = settingsOrgUnitUUID || (await wxrks.getOrgUnit());
  const project = await wxrks.createProject({
    reference: `Auto Sync ${new Date().toISOString()}`,
    sourceLocale,
    orgUnitUUID,
  });
  await store.createProjectMapping(project.uuid, {
    mode: "auto",
    sourceLocale,
    targetLocales,
    orgUnitUUID,
    workUnitNamePattern,
    status: "in_progress",
    wxrksStatus: "DRAFT",
  });

  let itemsSynced = 0;
  for (const { collection, item } of batch) {
    try {
      const result = await syncItemIntoBatch({
        projectUuid: project.uuid,
        collection,
        item,
        targetLocales,
        namePattern: workUnitNamePattern,
      });
      if (!result.skipped) {
        itemsSynced += 1;
        await store.markAutoSynced(collection.id, item.id, item.lastPublished);
      }
    } catch (err) {
      console.error(`Auto Sync item failed (${collection.id}/${item.id}):`, err.message);
      // No per-item retry queue -- reconciliation picks it back up on its
      // own next pass, since markAutoSynced was never called for it.
    }
  }

  await store.setLastSync({
    mode: "auto",
    summary: { itemsProcessed: batch.length, itemsSynced, wxrksProjectUUID: project.uuid, orgUnitUUID, targetLocales },
  });

  if (autoApprove && itemsSynced > 0) {
    requestBatchApproval(project.uuid);
  }
}

module.exports = {
  enqueue,
  startFlushLoop,
  stopFlushLoop,
  flush,
  pendingCount: () => pending.size,
  pendingSince: () => [...pending.values()].map((v) => v.enqueuedAt).sort()[0] || null,
  lastFlushAt: () => lastFlushAt,
};
