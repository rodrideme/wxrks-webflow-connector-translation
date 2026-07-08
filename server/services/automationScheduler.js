/**
 * Orchestrates one automation's scheduled cycle. Webflow's webhook API has
 * no granular "page changed" or "component changed" event (confirmed live:
 * only page_created/page_metadata_updated/page_deleted/site_publish, and
 * nothing component-level at all) -- so unlike CMS (real-time webhook ->
 * autoSyncQueue.enqueue, called from routes/webhooks.js), Pages and
 * Components automations poll on their own scheduled flush times: this
 * module scans their scope for anything changed since the last checkpoint/
 * hash, enqueues what qualifies, then flushes.
 */

const crypto = require("crypto");
const webflow = require("./webflow");
const webflowDom = require("./webflowDom");
const store = require("../store");
const autoSyncQueue = require("./autoSyncQueue");

function needsPagesScan(automation) {
  return automation.contentScope.type === "all" || automation.contentScope.type === "pages";
}

function needsComponentsScan(automation) {
  return automation.contentScope.type === "all" || automation.contentScope.type === "components";
}

async function scanAndEnqueuePages(automation, { sourceLocale }) {
  const allPages = await webflow.listStaticPages();
  const inScope =
    automation.contentScope.type === "all"
      ? allPages
      : webflow.filterPagesByFolderScope(allPages, automation.contentScope.pageFolderIds || []);

  const cutoff = automation.checkpoint.lastCheckpoint ? new Date(automation.checkpoint.lastCheckpoint) : new Date(0);
  for (const page of inScope) {
    if (!page.lastUpdated || new Date(page.lastUpdated) <= cutoff) continue;
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
    const nodes = await webflow.getComponentDom(component.id, { locale: sourceLocale });
    const contentHash = hashNodes(nodes);
    if (store.isAutomationComponentAlreadySynced(automation, component.id, contentHash)) continue;
    autoSyncQueue.enqueueComponent({ automation, component, nodes, contentHash });
  }
}

async function runAutomationCycle(automation) {
  const settings = await store.getSettings();
  const scanCutoff = new Date(); // captured before scanning -- anything changed mid-scan is picked up next cycle

  if (needsPagesScan(automation)) {
    await scanAndEnqueuePages(automation, settings);
  }
  if (needsComponentsScan(automation)) {
    await scanAndEnqueueComponents(automation, settings);
  }

  await autoSyncQueue.flush(automation.id);
  await store.advanceAutomationCheckpoint(automation.id, scanCutoff.toISOString());
}

module.exports = { runAutomationCycle };
