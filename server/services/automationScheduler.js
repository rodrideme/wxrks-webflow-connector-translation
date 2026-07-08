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

module.exports = { runAutomationCycle };
