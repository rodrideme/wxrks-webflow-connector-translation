/**
 * Hard-resets one environment (account) back to "never connected": after
 * this, the next "Sign in with Webflow" for that site goes through the
 * full first-time OAuth + account-creation + setup flow (routes/auth.js's
 * callback finds no account for the site id and creates a fresh one) --
 * built for re-recordable Marketplace demo/review runs against a demo
 * site. Operator-only; wired up in routes/environments.js.
 *
 * Ordering here is load-bearing:
 *  1. Flip status off 'active' first -- listAllAccounts() filters on it,
 *     which immediately hides the account from the autoSyncQueue flush and
 *     autoSyncReconciliation loops so neither touches it mid-purge.
 *  2. Discard this account's queued auto-sync entries, so nothing already
 *     enqueued can flush into wxrks after the purge.
 *  3. Tear down the account's Webflow-side webhook registrations while the
 *     webhook ids (app_state settings) and the account's own API token
 *     (webflow_connections) still exist -- purge first and the live
 *     webhooks are orphaned on the Webflow site with no record of their
 *     ids left to delete them by. Best-effort: a dead token must not block
 *     the reset (routes/webhooks.js drops deliveries for unknown accounts,
 *     so an orphan is noise, not a hazard) -- but it's reported back so
 *     the operator knows to prune the registration in Webflow by hand.
 *  4. Delete everything in one transaction (store.purgeAccount).
 *
 * Deliberately untouched: the Webflow site itself (content, locales,
 * published translations) and the wxrks-side projects this environment
 * created -- wxrks's API has no project delete, so they simply remain in
 * the wxrks org unit, disconnected from anything here.
 *
 * In-memory per-account caches (webflow.js, wxrks.js) are NOT cleared:
 * they're keyed by account id, and a re-connection creates a brand-new
 * account id (store.createAccount mints a fresh UUID), so stale entries
 * under the old id are unreachable garbage, not a correctness risk.
 */

const store = require("../store");
const accountContext = require("./accountContext");
const autoSyncWebhook = require("./autoSyncWebhook");
const autoSyncQueue = require("./autoSyncQueue");

function isOriginalAccount(account) {
  return Boolean(account.webflowSiteId && account.webflowSiteId === process.env.WEBFLOW_SITE_ID);
}

async function resetEnvironment(accountId) {
  const account = await store.getAccount(accountId);
  if (!account) {
    throw new Error("No such environment");
  }
  // The original account can't meaningfully be reset anyway (index.js's
  // migrateSingleTenantToAccountOne recreates it from env vars on next
  // boot, and its credentials are env-based) -- and it's the operator's own
  // admin surface, so deleting it would lock the operator out.
  if (isOriginalAccount(account)) {
    throw new Error("The original (operator) account can't be reset");
  }

  await store.setAccountStatus(accountId, "resetting");

  try {
    const automations = await store.listAutomations(accountId);
    const discardedQueueEntries = autoSyncQueue.discardPendingForAutomations(automations.map((a) => a.id));

    let webhookTeardown = { ok: true };
    try {
      await accountContext.run(accountId, async () => {
        await autoSyncWebhook.teardownWebhook(accountId);
        await autoSyncWebhook.teardownPagesWebhook(accountId);
      });
    } catch (err) {
      console.error(`Webhook teardown failed while resetting account ${accountId}:`, err.message);
      webhookTeardown = { ok: false, error: err.message };
    }

    const deleted = await store.purgeAccount(accountId);
    return { webflowSiteId: account.webflowSiteId, deleted, discardedQueueEntries, webhookTeardown };
  } catch (err) {
    // Leave the account visible/retryable rather than stranded in
    // 'resetting' (which listAllAccounts -- and so the background loops --
    // would skip forever). Best-effort: if this also fails, the
    // Environments listing still shows the account (listEnvironmentAccounts
    // is unfiltered) so the reset can simply be retried.
    await store.setAccountStatus(accountId, "active").catch(() => {});
    throw err;
  }
}

module.exports = { resetEnvironment, isOriginalAccount };
