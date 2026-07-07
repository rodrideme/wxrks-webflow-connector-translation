/**
 * Auto Sync's debounce/batch queue. Qualifying published items accumulate
 * here (in-memory, matching the existing non-persisted syncJobs pattern in
 * store.js) and get flushed into a single shared wxrks project at specific
 * clock times each day (settings.autoSync.flushTimes, e.g. ["00:00",
 * "12:00"]) -- not a sliding/resetting debounce, so latency stays bounded
 * even during a burst of edits, and the user can see/edit exactly when it
 * happens rather than an opaque "every N hours" cadence. A manual "flush
 * now" is also available (see flush() below, called directly from a route).
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
let scheduleTimer = null;
let lastFlushAt = null;
let currentFlushTimes = [];
let lastFiredMinuteKey = null;

function enqueue({ collection, item }) {
  pending.set(`${collection.id}:${item.id}`, { collection, item, enqueuedAt: new Date().toISOString() });
}

/**
 * Checks every 30s (well under a minute) whether the current UTC time
 * matches one of the configured flushTimes ("HH:mm"), and flushes if so.
 * lastFiredMinuteKey guards against firing twice for the same minute across
 * the two 30s ticks that fall within it.
 */
function startFlushLoop(flushTimes) {
  stopFlushLoop();
  currentFlushTimes = flushTimes || [];
  scheduleTimer = setInterval(() => {
    const now = new Date();
    const hhmm = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
    const minuteKey = now.toISOString().slice(0, 16);
    if (currentFlushTimes.includes(hhmm) && minuteKey !== lastFiredMinuteKey) {
      lastFiredMinuteKey = minuteKey;
      flush().catch((err) => console.error("Auto Sync flush failed:", err.message));
    }
  }, 30 * 1000);
}

function stopFlushLoop() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = null;
}

/**
 * Next scheduled flush time on or after `from`, given a sorted/unsorted list
 * of "HH:mm" UTC times. Wraps to the earliest time tomorrow if none remain
 * today.
 */
function nextFlushAt(flushTimes, from = new Date()) {
  if (!flushTimes || flushTimes.length === 0) return null;
  const sorted = [...flushTimes].sort();
  const todayStr = from.toISOString().slice(0, 10);
  for (const t of sorted) {
    const candidate = new Date(`${todayStr}T${t}:00.000Z`);
    if (candidate > from) return candidate.toISOString();
  }
  const tomorrow = new Date(from.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return new Date(`${tomorrow}T${sorted[0]}:00.000Z`).toISOString();
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
  nextFlushAt,
  pendingCount: () => pending.size,
  pendingSince: () => [...pending.values()].map((v) => v.enqueuedAt).sort()[0] || null,
  pendingItems: () =>
    [...pending.values()]
      .map((v) => ({
        collectionId: v.collection.id,
        collectionName: v.collection.displayName || v.collection.singularName || v.collection.id,
        itemId: v.item.id,
        itemName: v.item.fieldData?.name || v.item.fieldData?.slug || v.item.id,
        enqueuedAt: v.enqueuedAt,
      }))
      .sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt)),
  lastFlushAt: () => lastFlushAt,
  currentFlushTimes: () => currentFlushTimes,
};
