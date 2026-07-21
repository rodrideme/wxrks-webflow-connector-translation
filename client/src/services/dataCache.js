/**
 * Generic in-memory cache for GET-shaped data that's cheap to serve stale
 * for a short window -- module-level (not React state/context) so it
 * survives a page's full unmount/remount on route navigation (ES modules
 * are singletons; this object lives for the whole browser tab's session,
 * not any one component's lifetime). Deliberately NOT persisted to
 * localStorage/sessionStorage -- a hard refresh or new tab should always
 * see genuinely fresh data; this only smooths client-side route
 * navigation within one already-loaded session.
 */

const entries = new Map();

/**
 * Returns a cached in-flight/resolved promise for `key` if one exists and
 * hasn't expired, otherwise calls fetchFn() and caches its promise (not its
 * resolved value) immediately -- so concurrent callers within the same
 * tick (e.g. two pages both mounting and both calling getSettings()) also
 * dedupe onto one real network request. A rejected promise is evicted
 * immediately so a transient failure doesn't poison the cache for the rest
 * of the TTL window.
 */
function getOrFetch(key, ttlMs, fetchFn) {
  const entry = entries.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.promise;
  }
  const promise = fetchFn();
  promise.catch(() => entries.delete(key));
  entries.set(key, { promise, expiresAt: Date.now() + ttlMs });
  return promise;
}

/** Forces the next getOrFetch(key, ...) call to hit the network again. */
function invalidate(key) {
  entries.delete(key);
}

export default { getOrFetch, invalidate };
