/**
 * Carries "which account is this request/job for" implicitly through the
 * async call chain, using Node's built-in AsyncLocalStorage -- the standard
 * pattern for exactly this cross-cutting concern (Node's own docs use
 * "per-request tenant context" as the canonical example). Chosen over
 * threading `accountId` through every function's signature: webflow.js's
 * client()/siteId() are the ONLY things that actually need to become
 * account-aware (Phase 2), and they're purely internal to that one file --
 * threading an explicit parameter would have meant touching every route
 * file and service that calls into webflow.js's exported functions
 * (listCollections, getPageDom, etc.), none of which need to change at all
 * with this approach.
 *
 * Established once per logical unit of work:
 *  - middleware/auth.js's requireSession, for every authenticated HTTP
 *    request.
 *  - Each account's iteration inside the background loops (autoSyncQueue's
 *    flush loop, autoSyncReconciliation's reconcile, index.js's startup
 *    self-heal).
 *  - The account-scoped Webflow webhook handlers (routes/webhooks.js),
 *    which aren't behind requireSession at all (HMAC-verified instead).
 *
 * Once established, it propagates automatically through any async
 * continuation spawned within that call -- including a fire-and-forget
 * promise chain that outlives the original request/response (e.g.
 * automationScheduler.startFirstSyncJob's background flush), since
 * AsyncLocalStorage tracks the causal chain of async resource creation, not
 * just the current call stack.
 */

const { AsyncLocalStorage } = require("async_hooks");

const storage = new AsyncLocalStorage();

function run(accountId, fn) {
  return storage.run({ accountId }, fn);
}

function getAccountId() {
  const store = storage.getStore();
  if (!store) {
    throw new Error(
      "No account context set -- this code path must run inside accountContext.run() (see middleware/auth.js, the background loops, or routes/webhooks.js)"
    );
  }
  return store.accountId;
}

module.exports = { run, getAccountId };
