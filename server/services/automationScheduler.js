/**
 * Orchestrates one automation's scheduled cycle. Webflow's webhook API has
 * no granular "page changed" or "component changed" event (confirmed live:
 * only page_created/page_metadata_updated/page_deleted/site_publish, and
 * nothing component-level at all) -- so unlike CMS (real-time webhook ->
 * autoSyncQueue.enqueue, called from routes/webhooks.js), Pages and
 * Components automations poll on their own scheduled cadence: this module
 * scans their scope for anything changed since it was last seen, enqueues
 * what qualifies, then flushes.
 */

const crypto = require("crypto");
const webflow = require("./webflow");
const { hashNodes } = require("./webflowDom");
const store = require("../store");
const autoSyncQueue = require("./autoSyncQueue");
const autoSyncReconciliation = require("./autoSyncReconciliation");

function leafIds(automation, kind) {
  return (automation.contentScope.leaves || []).filter((l) => l.kind === kind).map((l) => l.id);
}

function needsPagesScan(automation) {
  return automation.contentScope.scope === "all" || leafIds(automation, "pagesFolder").length > 0;
}

function needsComponentsScan(automation) {
  return automation.contentScope.scope === "all" || (automation.contentScope.leaves || []).some((l) => l.kind === "components");
}

// Webflow starts throttling after ~40 rapid sequential requests for exactly
// this pattern -- one DOM fetch per page/component (see webflow.js's
// 429-retry interceptor) -- so scans below fetch concurrently but bounded,
// not all-at-once. Confirmed safe at this magnitude via this session's
// earlier live testing (11-way concurrent collection fetches, no
// throttling); kept below that to stay well clear of the ~40 threshold.
const SCAN_CONCURRENCY = 8;

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * Per-page (not a single automation-wide cutoff): a page never seen before
 * either establishes a translate-nothing baseline (includeExisting: false --
 * "future content only") or gets enqueued immediately (includeExisting:
 * true -- backfill). A page seen before is enqueued only if its translatable
 * content actually changed since its own last delivery -- dedup hashes each
 * page's translatable DOM content rather than trusting Webflow's
 * `lastUpdated` field, which (confirmed live) gets bumped for every page on
 * a full "Publish site" action regardless of whether that page's content
 * changed, which was flooding the pending queue with the entire site after
 * any full-site publish. This is more robust than one global first-run flag:
 * a page added to scope later (new folder, new page) still gets correct
 * first-encounter treatment on its own.
 */
async function scanAndEnqueuePages(automation, { sourceLocale }) {
  const allPages = await webflow.listStaticPages();
  const inScope =
    automation.contentScope.scope === "all" ? allPages : webflow.filterPagesByFolderScope(allPages, leafIds(automation, "pagesFolder"));

  // The DOM fetch + hash is the expensive, purely-read part -- safe to run
  // concurrently. The baseline bookkeeping below is NOT: markAutomationPageSynced
  // does a read-merge-write against this same in-memory automation.checkpoint
  // snapshot, which never changes mid-scan -- calling it once per page (as the
  // old sequential version did) meant each of a scan's own writes silently
  // overwrote the previous one's newly-established hash in the same run
  // (only the last page processed ever actually persisted). Fixed by
  // collecting every hash first, then writing the whole merged checkpoint
  // once at the end.
  const scanned = await mapWithConcurrency(inScope, SCAN_CONCURRENCY, async (page) => {
    const nodes = await webflow.getPageDom(page.id, { locale: sourceLocale });
    return { page, contentHash: hashNodes(nodes) };
  });

  const lastSyncedPageHashes = { ...automation.checkpoint.lastSyncedPageHashes };
  let changed = false;
  for (const { page, contentHash } of scanned) {
    const everSeen = Boolean(lastSyncedPageHashes[page.id]);
    if (!everSeen && !automation.includeExisting) {
      lastSyncedPageHashes[page.id] = contentHash;
      changed = true;
      continue;
    }
    if (lastSyncedPageHashes[page.id] === contentHash) continue;
    autoSyncQueue.enqueuePage({ automation, page });
  }
  if (changed) {
    await store.updateAutomation(automation.accountId, automation.id, {
      checkpoint: { ...automation.checkpoint, lastSyncedPageHashes },
    });
  }
}

async function scanAndEnqueueComponents(automation, { sourceLocale }) {
  // Components always all-or-nothing (no sub-scope) -- and carry no
  // modification timestamp at all (confirmed live), so dedup hashes each
  // component's translatable DOM content and compares against the last
  // synced hash, rather than a cheap timestamp comparison. Concurrency +
  // batched-write reasoning mirrors scanAndEnqueuePages above exactly.
  const components = await webflow.listComponents();

  const scanned = await mapWithConcurrency(components, SCAN_CONCURRENCY, async (component) => {
    const nodes = await webflow.getComponentDom(component.id, { locale: sourceLocale });
    const properties = await webflow.getComponentProperties(component.id, { locale: sourceLocale });
    return { component, contentHash: hashNodes(nodes, properties) };
  });

  const lastSyncedComponentHashes = { ...automation.checkpoint.lastSyncedComponentHashes };
  let changed = false;
  for (const { component, contentHash } of scanned) {
    const everSeen = Boolean(lastSyncedComponentHashes[component.id]);
    if (!everSeen && !automation.includeExisting) {
      lastSyncedComponentHashes[component.id] = contentHash;
      changed = true;
      continue;
    }
    if (lastSyncedComponentHashes[component.id] === contentHash) continue;
    autoSyncQueue.enqueueComponent({ automation, component });
  }
  if (changed) {
    await store.updateAutomation(automation.accountId, automation.id, {
      checkpoint: { ...automation.checkpoint, lastSyncedComponentHashes },
    });
  }
}

async function runAutomationCycle(automation) {
  const settings = await store.getSettings(automation.accountId);
  const scanCutoff = new Date(); // captured before scanning -- anything changed mid-scan is picked up next cycle

  if (needsPagesScan(automation)) {
    await scanAndEnqueuePages(automation, settings);
  }
  if (needsComponentsScan(automation)) {
    await scanAndEnqueueComponents(automation, settings);
  }

  await autoSyncQueue.flush(automation.id);
  await store.advanceAutomationCheckpoint(automation, scanCutoff.toISOString());
}

/**
 * Runs immediately when a new automation is created with "include existing
 * content on the first run" checked -- otherwise the backfill only happened
 * passively, on whichever came first: this automation's own cadence tick
 * (could be a full day away for a daily/weekly schedule) or the hourly CMS
 * reconciliation safety net. Neither is "right away", which is what the
 * wizard's checkbox copy promises. Mirrors runAutomationCycle but also scans
 * CMS collections (reconciliation's per-automation scan, reused directly
 * since its cutoff/qualification logic already does the right thing for a
 * checkpoint-less automation) so a scope spanning multiple content kinds
 * still lands in a single wxrks project.
 *
 * Split into two phases so the caller (routes/automations.js) can respond
 * to the wizard IMMEDIATELY with a jobId to poll, instead of blocking the
 * whole automation-creation request on the scan -- confirmed live this can
 * mean on the order of 100+ individual Webflow calls for "All content"
 * scope (one DOM fetch per page/component; unlike CMS items there's no
 * bulk endpoint for those), which the user experienced as the wizard's
 * modal sitting on "Sending..." for close to two minutes with zero
 * feedback, unlike a CMS-only selection (which skips the Pages/Components
 * scan entirely and uses CMS's cheap paginated bulk fetch instead).
 *   1. scanForFirstSync: enumerates matching content and enqueues it.
 *   2. startFirstSyncJob: creates a sync job SYNCHRONOUSLY, before any
 *      scanning happens, and returns { jobId, total: 0, scanning: true }
 *      right away. The scan, and then the actual flush, both run after in
 *      the background, updating that same job as they progress. The
 *      wizard polls it exactly like a one-time send's job -- see
 *      Translate.jsx/TranslateActionBar.jsx's `scanning` handling -- showing
 *      a "Scanning your site..." state while `scanning` is true, then the
 *      normal item-by-item progress bar once the scan hands off to
 *      flush() and `total` becomes real.
 */
async function scanForFirstSync(automation) {
  const settings = await store.getSettings(automation.accountId);
  const allCollections = await webflow.listCollections();
  await autoSyncReconciliation.reconcileAutomation(automation, allCollections);

  if (needsPagesScan(automation)) {
    await scanAndEnqueuePages(automation, settings);
  }
  if (needsComponentsScan(automation)) {
    await scanAndEnqueueComponents(automation, settings);
  }
  return settings;
}

function startFirstSyncJob(automation) {
  const jobId = crypto.randomUUID();
  store.createSyncJob({
    id: jobId,
    mode: "automation",
    total: 0,
    wxrksProjectUUID: null,
    orgUnitUUID: automation.orgUnitOverride || null,
    targetLocales: automation.targetLocalesOverride || [],
    scanning: true,
  });

  // Fire-and-forget from here -- the route responds with {jobId, total: 0,
  // scanning: true} as soon as this function returns, before any of the
  // scan's real Webflow calls have even started.
  (async () => {
    const scanCutoff = new Date();
    try {
      const settings = await scanForFirstSync(automation);
      const total = autoSyncQueue.pendingCount(automation.id);
      if (total === 0) {
        await store.advanceAutomationCheckpoint(automation, scanCutoff.toISOString());
        store.updateSyncJob(jobId, { status: "completed", scanning: false });
        return;
      }

      const orgUnitUUID = automation.orgUnitOverride || settings.orgUnitUUID;
      const targetLocales = automation.targetLocalesOverride?.length ? automation.targetLocalesOverride : settings.targetLocales;
      store.updateSyncJob(jobId, { total, orgUnitUUID, targetLocales, scanning: false });

      await autoSyncQueue.flush(automation.id, { jobId });
      await store.advanceAutomationCheckpoint(automation, scanCutoff.toISOString());
    } catch (err) {
      console.error(`Automation "${automation.name}" first-run scan/flush failed:`, err.message);
      store.updateSyncJob(jobId, { status: "error", scanning: false });
    }
  })();

  return { jobId, total: 0, scanning: true };
}

/**
 * Fired from the site_publish webhook (routes/webhooks.js's account-scoped
 * webhook URL identifies which account this is for) -- scans every enabled,
 * non-archived automation *in that account* that needs Pages/Components and
 * enqueues anything new/changed, WITHOUT flushing or advancing its
 * checkpoint. This mirrors the CMS live webhook's own behavior (enqueue
 * only; sending to wxrks still waits for the automation's own cadence tick
 * or a manual flush) -- Pages/Components previously only got scanned at all
 * on that same cadence tick, so a page/component published between ticks
 * wouldn't even show up in the pending queue until the next one (up to a
 * day away for a daily schedule). Safe to call as often as publishes
 * arrive: both scan functions enqueue idempotently (autoSyncQueue's map
 * overwrites by key) and skip anything already synced.
 */
async function scanAndEnqueueForPublishEvent(accountId) {
  const settings = await store.getSettings(accountId);
  const automations = await store.listAutomations(accountId);
  const relevant = automations.filter((a) => a.enabled && !a.archived && (needsPagesScan(a) || needsComponentsScan(a)));

  for (const automation of relevant) {
    if (needsPagesScan(automation)) {
      await scanAndEnqueuePages(automation, settings);
    }
    if (needsComponentsScan(automation)) {
      await scanAndEnqueueComponents(automation, settings);
    }
  }
}

module.exports = { runAutomationCycle, startFirstSyncJob, scanAndEnqueueForPublishEvent };
