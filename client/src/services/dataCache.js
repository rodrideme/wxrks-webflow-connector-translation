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
 *
 * Every entry is namespaced by the logged-in ACCOUNT id (set by
 * AuthContext via setNamespace on each /auth/me resolution). Both layers
 * outlive a logout->login inside the same tab -- the Map because no page
 * reload happens on a password login, sessionStorage because it survives
 * even the OAuth full-page redirect -- and un-namespaced keys used to hand
 * the new login the PREVIOUS account's collections/site/settings. The
 * namespace makes a cross-account hit impossible even if a clear is
 * missed, and setNamespace additionally wipes everything whenever the
 * account actually changes (tracked across reloads via a persisted
 * marker).
 */

const STORAGE_PREFIX = "dataCache:";
const NAMESPACE_MARKER_KEY = STORAGE_PREFIX + "__namespace";

const entries = new Map();
// The logged-in account id; null until AuthContext resolves /auth/me.
let namespace = null;

/**
 * Called by AuthContext on every /auth/me resolution (account id) and on
 * logout/401 (null). Any change of account -- including across a full-page
 * OAuth redirect, where the in-memory Map already died but sessionStorage
 * survived (hence the persisted marker) -- wipes both layers outright.
 */
function setNamespace(ns) {
  const next = ns || null;
  let persisted = null;
  try {
    persisted = sessionStorage.getItem(NAMESPACE_MARKER_KEY);
  } catch {
    // storage disabled -- the in-memory namespace check still applies
  }
  if ((namespace && namespace !== next) || (persisted && persisted !== next)) {
    clearAll();
  }
  namespace = next;
  if (next) {
    try {
      sessionStorage.setItem(NAMESPACE_MARKER_KEY, next);
    } catch {
      // ignore
    }
  }
}

/** Drops everything: the in-memory Map and every dataCache:-prefixed sessionStorage key. */
function clearAll() {
  entries.clear();
  try {
    // Collect first, then remove -- removing while indexing shifts key(i).
    const doomed = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function readPersisted(nsKey) {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + nsKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.expiresAt <= Date.now()) {
      sessionStorage.removeItem(STORAGE_PREFIX + nsKey);
      return null;
    }
    return parsed;
  } catch {
    return null; // corrupted entry, private-browsing storage block, etc.
  }
}

function writePersisted(nsKey, value, expiresAt) {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + nsKey, JSON.stringify({ value, expiresAt }));
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
 *
 * With no namespace established yet, bypasses the cache entirely (fetch,
 * don't store) -- nothing can ever be cached under the wrong account. In
 * practice unreachable: App.jsx only mounts pages once /auth/me resolved,
 * and AuthContext sets the namespace before that state flip.
 */
function getOrFetch(key, ttlMs, fetchFn) {
  if (!namespace) return fetchFn();
  const nsKey = `${namespace}:${key}`;

  const entry = entries.get(nsKey);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.promise;
  }

  const persisted = readPersisted(nsKey);
  if (persisted) {
    const promise = Promise.resolve(persisted.value);
    entries.set(nsKey, { promise, expiresAt: persisted.expiresAt });
    return promise;
  }

  const expiresAt = Date.now() + ttlMs;
  const promise = fetchFn();
  promise.then((value) => writePersisted(nsKey, value, expiresAt)).catch(() => entries.delete(nsKey));
  entries.set(nsKey, { promise, expiresAt });
  return promise;
}

/** Forces the next getOrFetch(key, ...) call to hit the network again. */
function invalidate(key) {
  if (!namespace) return;
  const nsKey = `${namespace}:${key}`;
  entries.delete(nsKey);
  try {
    sessionStorage.removeItem(STORAGE_PREFIX + nsKey);
  } catch {
    // ignore
  }
}

export default { getOrFetch, invalidate, setNamespace, clearAll };
