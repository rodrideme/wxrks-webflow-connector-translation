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
const webflowDom = require("./webflowDom");
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

/**
 * Per-page (not a single automation-wide cutoff): a page never seen before
 * either establishes a translate-nothing baseline (includeExisting: false --
 * "future content only") or gets enqueued immediately (includeExisting:
 * true -- backfill). A page seen before is enqueued only if it changed
 * since its own last delivery. This is more robust than one global
 * first-run flag: a page added to scope later (new folder, new page) still
 * gets correct first-encounter treatment on its own.
 */
async function scanAndEnqueuePages(automation) {
  const allPages = await webflow.listStaticPages();
  const inScope =
    automation.contentScope.scope === "all" ? allPages : webflow.filterPagesByFolderScope(allPages, leafIds(automation, "pagesFolder"));

  for (const page of inScope) {
    const everSeen = Boolean(automation.checkpoint.lastSyncedPages?.[page.id]);
    if (!everSeen && !automation.includeExisting) {
      await store.markAutomationPageSynced(automation.id, page.id, page.lastUpdated);
      continue;
    }
    if (store.isAutomationPageAlreadySynced(automation, page.id, page.lastUpdated)) continue;
    autoSyncQueue.enqueuePage({ automation, page });
  }
}

function hashNodes(nodes) {
  const translatableText = webflowDom.extractTextNodes(nodes);
  return crypto.createHash("sha256").update(JSON.stringify(translatableText)).digest("hex");
}

async function scanAndEnqueueComponents(automation, { sourceLocale }) {
  // Components always all-or-nothing (no sub-scope) -- and carry no
  // modification timestamp at all (confirmed live), so dedup hashes each
  // component's translatable DOM content and compares against the last
  // synced hash, rather than a cheap timestamp comparison.
  const components = await webflow.listComponents();
  for (const component of components) {
    const everSeen = Boolean(automation.checkpoint.lastSyncedComponentHashes?.[component.id]);
    const nodes = await webflow.getComponentDom(component.id, { locale: sourceLocale });
    const contentHash = hashNodes(nodes);
    if (!everSeen && !automation.includeExisting) {
      await store.markAutomationComponentSynced(automation.id, component.id, contentHash);
      continue;
    }
    if (store.isAutomationComponentAlreadySynced(automation, component.id, contentHash)) continue;
    autoSyncQueue.enqueueComponent({ automation, component, nodes, contentHash });
  }
}

async function runAutomationCycle(automation) {
  const settings = await store.getSettings();
  const scanCutoff = new Date(); // captured before scanning -- anything changed mid-scan is picked up next cycle

  if (needsPagesScan(automation)) {
    await scanAndEnqueuePages(automation);
  }
  if (needsComponentsScan(automation)) {
    await scanAndEnqueueComponents(automation, settings);
  }

  await autoSyncQueue.flush(automation.id);
  await store.advanceAutomationCheckpoint(automation.id, scanCutoff.toISOString());
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
 * checkpoint-less automation) and flushes once at the end so a scope
 * spanning multiple content kinds still lands in a single wxrks project.
 */
async function runFirstSyncNow(automation) {
  const settings = await store.getSettings();
  const scanCutoff = new Date();

  const allCollections = await webflow.listCollections();
  await autoSyncReconciliation.reconcileAutomation(automation, allCollections);

  if (needsPagesScan(automation)) {
    await scanAndEnqueuePages(automation);
  }
  if (needsComponentsScan(automation)) {
    await scanAndEnqueueComponents(automation, settings);
  }

  await autoSyncQueue.flush(automation.id);
  await store.advanceAutomationCheckpoint(automation.id, scanCutoff.toISOString());
}

/**
 * Fired from the site_publish webhook (routes/webhooks.js) -- scans every
 * enabled, non-archived automation that needs Pages/Components and enqueues
 * anything new/changed, WITHOUT flushing or advancing its checkpoint. This
 * mirrors the CMS live webhook's own behavior (enqueue only; sending to
 * wxrks still waits for the automation's own cadence tick or a manual
 * flush) -- Pages/Components previously only got scanned at all on that
 * same cadence tick, so a page/component published between ticks wouldn't
 * even show up in the pending queue until the next one (up to a day away
 * for a daily schedule). Safe to call as often as publishes arrive: both
 * scan functions enqueue idempotently (autoSyncQueue's map overwrites by
 * key) and skip anything already synced.
 */
async function scanAndEnqueueForPublishEvent() {
  const settings = await store.getSettings();
  const automations = await store.listAutomations();
  const relevant = automations.filter((a) => a.enabled && !a.archived && (needsPagesScan(a) || needsComponentsScan(a)));

  for (const automation of relevant) {
    if (needsPagesScan(automation)) {
      await scanAndEnqueuePages(automation);
    }
    if (needsComponentsScan(automation)) {
      await scanAndEnqueueComponents(automation, settings);
    }
  }
}

module.exports = { runAutomationCycle, runFirstSyncNow, scanAndEnqueueForPublishEvent };
