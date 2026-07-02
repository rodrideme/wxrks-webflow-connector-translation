/**
 * Auto Sync loop-prevention.
 *
 * A live test (registering a temporary Webflow webhook and making real
 * edits) proved that a `collection_item_changed`/`collection_item_published`
 * payload's `cmsLocaleId` field does NOT reliably indicate which locale was
 * actually edited -- it consistently reported the primary locale's id even
 * when only a secondary locale's field was changed. So there's no reliable
 * way to filter "was this our own translation push-back landing on a target
 * locale" purely from the inbound webhook payload.
 *
 * Instead: every time server/routes/webhooks.js's `/wxrks` handler
 * successfully writes a translation back via webflow.patchItemLocale(), it
 * calls markSelfWrite() here. The inbound `/webflow` Auto Sync webhook
 * checks isRecentSelfWrite() before doing anything else -- if this item was
 * written by us within the cooldown window, the incoming
 * collection_item_changed/published event is almost certainly an echo of
 * that write, not a real human edit, so it's ignored entirely (a blanket
 * per-item cooldown, not per-locale, since we can't tell locales apart
 * anyway).
 *
 * In-memory only, matching the existing non-persisted syncJobs Map pattern
 * in store.js -- losing this on a restart just means a translation
 * push-back that happens to land in the few seconds around a restart could
 * theoretically slip through and get re-queued by Auto Sync. Acceptable:
 * worst case is one redundant sync of already-translated content, not a
 * runaway loop (the wxrks side would just re-translate already-correct
 * source content into the same result).
 */

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // comfortably longer than any realistic webhook delivery delay

const recentWrites = new Map(); // `${collectionId}:${itemId}` -> timestamp (ms)

function key(collectionId, itemId) {
  return `${collectionId}:${itemId}`;
}

function markSelfWrite(collectionId, itemId) {
  recentWrites.set(key(collectionId, itemId), Date.now());
}

function isRecentSelfWrite(collectionId, itemId, { withinMs = DEFAULT_COOLDOWN_MS } = {}) {
  const writtenAt = recentWrites.get(key(collectionId, itemId));
  if (!writtenAt) return false;
  return Date.now() - writtenAt < withinMs;
}

module.exports = { markSelfWrite, isRecentSelfWrite };
