/**
 * Cache for GET-shaped data that's cheap to serve stale for a while.
 * Two layers:
 *  - An in-memory Map (module-level, not React state/context) -- survives a
 *    page's full unmount/remount on route navigation, and caches the
 *    in-flight PROMISE (not just the resolved value) so concurrent callers
 *    within the same tick (e.g. two pages both mounting and both calling
 *    getSettings()) dedupe onto one real network request.
 *  - sessionStorage -- survives a hard refresh (a fresh page load has no
 *    in-memory state at all) but not a closed tab/new tab, which is exactly
 *    the boundary wanted: a reload within the same working session shouldn't
 *    re-pay for a whole-site rescan, but a genuinely new session should see
 *    real data, not something persisted indefinitely. Only resolved values
 *    are written here (a Promise can't be serialized) -- read back on a
 *    cache miss and immediately re-wrapped as a resolved promise, so the two
 *    layers share one code path either way.
 */

const STORAGE_PREFIX = "dataCache:";

const entries = new Map();

function readPersisted(key) {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.expiresAt <= Date.now()) {
      sessionStorage.removeItem(STORAGE_PREFIX + key);
      return null;
    }
    return parsed;
  } catch {
    return null; // corrupted entry, private-browsing storage block, etc.
  }
}

function writePersisted(key, value, expiresAt) {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify({ value, expiresAt }));
  } catch {
    // Quota exceeded, storage disabled, or a non-serializable value --
    // silently skip persistence. The in-memory layer still works for the
    // rest of this page life either way.
  }
}

/**
 * Returns a cached in-flight/resolved promise for `key` if one exists and
 * hasn't expired (in-memory first, then sessionStorage), otherwise calls
 * fetchFn() and caches it. A rejected promise is evicted immediately so a
 * transient failure doesn't poison the cache for the rest of the TTL window.
 */
function getOrFetch(key, ttlMs, fetchFn) {
  const entry = entries.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.promise;
  }

  const persisted = readPersisted(key);
  if (persisted) {
    const promise = Promise.resolve(persisted.value);
    entries.set(key, { promise, expiresAt: persisted.expiresAt });
    return promise;
  }

  const expiresAt = Date.now() + ttlMs;
  const promise = fetchFn();
  promise.then((value) => writePersisted(key, value, expiresAt)).catch(() => entries.delete(key));
  entries.set(key, { promise, expiresAt });
  return promise;
}

/** Forces the next getOrFetch(key, ...) call to hit the network again. */
function invalidate(key) {
  entries.delete(key);
  try {
    sessionStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    // ignore
  }
}

export default { getOrFetch, invalidate };
