/**
 * Automation's debounce/batch queue. Qualifying CMS items (from the live
 * webhook) and Pages/Components (from automationScheduler's polling scans)
 * accumulate here in-memory and get flushed into one shared wxrks project
 * per automation at that automation's own scheduled cadence (hourly/daily/
 * weekly, see cadenceMatchesNow below) -- not a sliding/resetting debounce,
 * so latency stays bounded even during a burst of edits. A manual "flush
 * now" is also available per automation (see flush() below, called from
 * routes/automations.js).
 *
 * If the process restarts before a flush, queued-but-unflushed CMS items are
 * lost -- acceptable, since autoSyncReconciliation.js re-scans for anything
 * published since the last checkpoint and re-enqueues it regardless. Pages/
 * Components have no separate safety net since their scheduled poll IS the
 * primary mechanism and will simply pick up the same content next cycle.
 */

const store = require("../store");
const wxrks = require("../services/wxrks");
const webflow = require("./webflow");
const accountContext = require("./accountContext");
const { hashNodes } = require("./webflowDom");
const { syncItemIntoBatch, syncPageIntoBatch, syncComponentIntoBatch, requestBatchApproval } = require("./syncCore");

// Map keyed by `${automationId}:cms:${collectionId}:${itemId}` /
// `${automationId}:page:${pageId}` / `${automationId}:component:${componentId}`
// -> { automationId, entityType, collection?, item?, page?, component?,
// nodes?, enqueuedAt }. Re-enqueuing the same key before the next flush
// overwrites rather than duplicates. Two automations targeting overlapping
// content dedup independently since the automation id is part of the key.
const pending = new Map();
let lastFlushAt = null;
let scheduleTimer = null;
// automationId -> minuteKey of its last fire, guards against firing twice
// for the same minute across the two 30s ticks that fall within it.
const lastFiredMinuteKeyByAutomation = new Map();

function enqueue({ automation, collection, item }) {
  // "Created" if this item has never been delivered under this automation
  // before, else "Edited" -- matches the design's queue trigger badges.
  const everSynced = Boolean(automation.checkpoint.lastSyncedAt?.[collection.id]?.[item.id]);
  pending.set(`${automation.id}:cms:${collection.id}:${item.id}`, {
    automationId: automation.id,
    entityType: "cms",
    collection,
    item,
    trigger: everSynced ? "Edited" : "Created",
    enqueuedAt: new Date().toISOString(),
  });
}

// `nodes` deliberately not carried into the pending entry -- flush() always
// re-fetches content fresh right before actually syncing (see flush()'s
// comment), so holding a full DOM node list in memory here from scan time
// would just be dead weight (and, worse, a source of staleness bugs).
function enqueuePage({ automation, page }) {
  const everSynced = Boolean(automation.checkpoint.lastSyncedPageHashes?.[page.id]);
  pending.set(`${automation.id}:page:${page.id}`, {
    automationId: automation.id,
    entityType: "page",
    page,
    trigger: everSynced ? "Edited" : "Created",
    enqueuedAt: new Date().toISOString(),
  });
}

function enqueueComponent({ automation, component }) {
  const everSynced = Boolean(automation.checkpoint.lastSyncedComponentHashes?.[component.id]);
  pending.set(`${automation.id}:component:${component.id}`, {
    automationId: automation.id,
    entityType: "component",
    component,
    trigger: everSynced ? "Edited" : "Created",
    enqueuedAt: new Date().toISOString(),
  });
}

/**
 * Formats a UTC instant as "HH:mm" wall-clock time (or, with `part:
 * "weekday"`, a short weekday name like "Mon") in the given IANA timezone --
 * DST-correct via Intl, no date library needed.
 */
function formatInTimeZone(date, timeZone, part = "time") {
  if (part === "weekday") {
    return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const hh = parts.find((p) => p.type === "hour").value;
  const mm = parts.find((p) => p.type === "minute").value;
  return `${hh}:${mm}`;
}

// Every "HH:mm" an hourly cadence fires at, evenly spaced every `everyHours`
// starting from `startTime` (wraps across midnight).
function hourlyTimes(startTime, everyHours) {
  const [sh, sm] = (startTime || "00:00").split(":").map(Number);
  const startMinutes = sh * 60 + sm;
  const times = [];
  for (let m = startMinutes; m < startMinutes + 24 * 60; m += Math.max(1, everyHours) * 60) {
    const wrapped = ((m % (24 * 60)) + 24 * 60) % (24 * 60);
    const hh = String(Math.floor(wrapped / 60)).padStart(2, "0");
    const mm = String(wrapped % 60).padStart(2, "0");
    times.push(`${hh}:${mm}`);
  }
  return times;
}

/**
 * Whether an automation's cadence fires at this exact wall-clock moment
 * (hhmm + weekday, both already resolved to the app's timezone).
 */
function cadenceMatchesNow(cadence, hhmm, weekday) {
  if (cadence.kind === "hourly") return hourlyTimes(cadence.startTime, cadence.everyHours).includes(hhmm);
  if (cadence.kind === "weekly") return cadence.weekday === weekday && cadence.time === hhmm;
  return cadence.time === hhmm; // "daily"
}

/**
 * Checks every 30s (well under a minute) whether the current wall-clock time
 * (in each account's own timezone) matches any of ITS enabled automations'
 * cadence, firing that automation's cycle if so. Iterates every account
 * (Phase 1 multi-tenancy: data is account-scoped even though Webflow/wxrks
 * credentials are still global -- see the plan file) -- in practice just
 * one account for a good while, but this loop is what the second real
 * account's automations would need working on day one. Re-queries fresh on
 * every tick (cheap -- a handful of rows per account) rather than being
 * restarted on every settings change, so it can simply run unconditionally
 * from server boot with no enable/disable start/stop dance.
 */
function startFlushLoop() {
  stopFlushLoop();
  scheduleTimer = setInterval(async () => {
    try {
      const { runAutomationCycle } = require("./automationScheduler");
      const now = new Date();
      const minuteKey = now.toISOString().slice(0, 16);

      const accounts = await store.listAllAccounts();
      for (const account of accounts) {
        // Establishes this account's context for the rest of this
        // iteration -- including runAutomationCycle's fire-and-forget
        // continuation below, which keeps it for its entire lifetime even
        // after this loop moves on to the next account (see
        // accountContext.js's docstring).
        await accountContext.run(account.id, async () => {
          const { timezone } = await store.getSettings(account.id);
          const hhmm = formatInTimeZone(now, timezone);
          const weekday = formatInTimeZone(now, timezone, "weekday");

          const automations = await store.listAutomations(account.id);
          for (const automation of automations) {
            if (!automation.enabled || automation.archived) continue;
            if (!cadenceMatchesNow(automation.cadence, hhmm, weekday)) continue;
            if (lastFiredMinuteKeyByAutomation.get(automation.id) === minuteKey) continue;
            lastFiredMinuteKeyByAutomation.set(automation.id, minuteKey);
            runAutomationCycle(automation).catch((err) =>
              console.error(`Automation "${automation.name}" cycle failed:`, err.message)
            );
          }
        });
      }
    } catch (err) {
      console.error("Automation flush loop tick failed:", err.message);
    }
  }, 30 * 1000);
}

function stopFlushLoop() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = null;
}

/**
 * Next scheduled flush time on or after `from`, given a cadence. Brute-force
 * scans minute-by-minute up to 8 days ahead (weekly cadences need more than
 * 48h of lookahead) -- simple and DST-correct (via Intl) rather than doing
 * timezone-offset arithmetic by hand; cheap enough since this only runs
 * on-demand (status polling), not in the hot scheduling path above.
 */
function nextFlushAt(cadence, timezone = "UTC", from = new Date()) {
  if (!cadence) return null;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 8; i++) {
    cursor.setTime(cursor.getTime() + 60000);
    const hhmm = formatInTimeZone(cursor, timezone);
    const weekday = formatInTimeZone(cursor, timezone, "weekday");
    if (cadenceMatchesNow(cadence, hhmm, weekday)) return cursor.toISOString();
  }
  return null;
}

/**
 * Flushes one automation's pending entries into a single shared wxrks
 * project. Called from the scheduled tick above, from
 * automationScheduler.runAutomationCycle (after a Pages/Components scan),
 * on-demand via POST /api/automations/:id/flush, and (with a jobId) from
 * automationScheduler.startFirstSyncJob for the "include existing content on
 * the first run" immediate backfill -- the optional `jobId` mirrors that
 * into store's sync-job tracking (progress + cancel), the same mechanism a
 * one-time send already uses, so the wizard can show the identical
 * progress-bar-with-cancel UI instead of the flush happening invisibly.
 */
async function flush(automationId, { jobId } = {}) {
  lastFlushAt = new Date().toISOString();
  const batch = [...pending.entries()].filter(([key]) => key.startsWith(`${automationId}:`));
  if (batch.length === 0) {
    if (jobId) store.updateSyncJob(jobId, { status: "completed" });
    return { itemsSynced: 0 };
  }

  // Clear before awaiting so new events arriving during the flush go into
  // the *next* window, not lost or double-counted.
  for (const [key] of batch) pending.delete(key);

  const automation = await store.getAutomationByIdUnscoped(automationId);
  if (!automation) {
    if (jobId) store.updateSyncJob(jobId, { status: "completed" });
    return { itemsSynced: 0 };
  }

  const settings = await store.getSettings(automation.accountId);
  const { sourceLocale, orgUnitUUID: settingsOrgUnitUUID, autoApprove, workUnitNamePattern } = settings;
  const targetLocales = automation.targetLocalesOverride?.length ? automation.targetLocalesOverride : settings.targetLocales;
  if (targetLocales.length === 0) {
    if (jobId) store.updateSyncJob(jobId, { status: "completed" });
    return { itemsSynced: 0 };
  }

  const orgUnitUUID = automation.orgUnitOverride || settingsOrgUnitUUID || (await wxrks.getOrgUnit());
  const project = await wxrks.createProject({
    reference: automation.projectName || `Automation "${automation.name}" ${new Date().toISOString()}`,
    sourceLocale,
    orgUnitUUID,
  });
  await store.createProjectMapping(automation.accountId, project.uuid, {
    mode: "automation",
    automationName: automation.name,
    sourceLocale,
    targetLocales,
    orgUnitUUID,
    workUnitNamePattern,
    status: "in_progress",
    wxrksStatus: "DRAFT",
  });
  if (jobId) store.updateSyncJob(jobId, { wxrksProjectUUID: project.uuid, orgUnitUUID, targetLocales });

  // Accumulated locally and written to the automation's checkpoint ONCE at
  // the end (below), instead of once per item -- markAutomationItemSynced/
  // markAutomationPageSynced/markAutomationComponentSynced each do a
  // read-merge-write against this same in-memory `automation.checkpoint`
  // snapshot, which never gets updated mid-loop. Calling any of them more
  // than once per flush (the normal case whenever a batch has more than one
  // item) meant every write fully overwrote the checkpoint column, silently
  // discarding every earlier item's hash/timestamp from the same batch --
  // only the last one processed ever actually persisted, causing already-
  // delivered items to look "changed" again and get needlessly re-synced on
  // the next cycle. Mirrors the identical fix in automationScheduler.js's
  // scan functions.
  const lastSyncedAt = { ...automation.checkpoint.lastSyncedAt };
  const lastSyncedPageHashes = { ...automation.checkpoint.lastSyncedPageHashes };
  const lastSyncedComponentHashes = { ...automation.checkpoint.lastSyncedComponentHashes };
  let checkpointChanged = false;

  let itemsSynced = 0;
  for (const [, entry] of batch) {
    if (jobId && store.getSyncJob(jobId)?.cancelled) break;

    try {
      if (entry.entityType === "cms") {
        const result = await syncItemIntoBatch({
          accountId: automation.accountId,
          projectUuid: project.uuid,
          collection: entry.collection,
          item: entry.item,
          targetLocales,
          namePattern: workUnitNamePattern,
          workflows: automation.workflows,
        });
        if (!result.skipped) {
          itemsSynced += 1;
          lastSyncedAt[entry.collection.id] = { ...lastSyncedAt[entry.collection.id], [entry.item.id]: entry.item.lastPublished };
          checkpointChanged = true;
        }
        if (jobId) store.appendSyncJobResult(jobId, { itemId: entry.item.id, ...result });
      } else if (entry.entityType === "page") {
        // Re-fetched fresh here rather than reusing the nodes/hash captured
        // at scan time -- confirmed live, a page scanned right at the
        // instant its site_publish webhook fires can still return stale/
        // incomplete content (Webflow's read API hadn't finished
        // propagating it yet), which was translating pages as empty right
        // after they were created. Fetching once, at the last possible
        // moment right before syncing, and using that exact fetch for both
        // the translation and the recorded hash keeps them from ever
        // disagreeing with each other.
        const nodes = await webflow.getPageDom(entry.page.id, { locale: sourceLocale });
        const contentHash = hashNodes(nodes);
        const result = await syncPageIntoBatch({
          projectUuid: project.uuid,
          page: entry.page,
          nodes,
          targetLocales,
          namePattern: settings.pagesWorkUnitNamePattern,
          workflows: automation.workflows,
        });
        if (!result.skipped) itemsSynced += 1;
        // Recorded even when skipped (no translatable text) -- otherwise a
        // genuinely empty page can never establish a baseline hash and
        // would reappear in the pending queue on every future scan forever.
        // If it's later edited to contain real text, the hash will differ
        // from this "empty" one and correctly re-enqueue it.
        lastSyncedPageHashes[entry.page.id] = contentHash;
        checkpointChanged = true;
        if (jobId) store.appendSyncJobResult(jobId, { itemId: entry.page.id, ...result });
      } else if (entry.entityType === "component") {
        const nodes = await webflow.getComponentDom(entry.component.id, { locale: sourceLocale });
        const contentHash = hashNodes(nodes);
        const result = await syncComponentIntoBatch({
          projectUuid: project.uuid,
          component: entry.component,
          nodes,
          targetLocales,
          namePattern: settings.componentsWorkUnitNamePattern,
          workflows: automation.workflows,
        });
        if (!result.skipped) itemsSynced += 1;
        lastSyncedComponentHashes[entry.component.id] = contentHash;
        checkpointChanged = true;
        if (jobId) store.appendSyncJobResult(jobId, { itemId: entry.component.id, ...result });
      }
    } catch (err) {
      console.error(`Automation "${automation.name}" item failed:`, err.message);
      // No per-item retry queue -- CMS gets picked back up by reconciliation;
      // Pages/Components get picked back up on the next scheduled scan since
      // their checkpoint/hash was never advanced for this entry.
      if (jobId) store.appendSyncJobResult(jobId, { error: err.message });
    }
  }

  if (checkpointChanged) {
    await store.updateAutomation(automation.accountId, automation.id, {
      checkpoint: { ...automation.checkpoint, lastSyncedAt, lastSyncedPageHashes, lastSyncedComponentHashes },
    });
  }

  await store.setLastSync(automation.accountId, {
    mode: "automation",
    summary: {
      itemsProcessed: batch.length,
      itemsSynced,
      wxrksProjectUUID: project.uuid,
      orgUnitUUID,
      targetLocales,
      automationName: automation.name,
    },
  });

  if (jobId) {
    const finalJob = store.getSyncJob(jobId);
    store.updateSyncJob(jobId, { status: finalJob?.cancelled ? "cancelled" : "completed" });
  }

  if (autoApprove && itemsSynced > 0) {
    requestBatchApproval(project.uuid);
  }

  return { itemsSynced };
}

module.exports = {
  enqueue,
  enqueuePage,
  enqueueComponent,
  startFlushLoop,
  stopFlushLoop,
  flush,
  nextFlushAt,
  hourlyTimes,
  pendingCount: (automationId) =>
    automationId ? [...pending.keys()].filter((k) => k.startsWith(`${automationId}:`)).length : pending.size,
  pendingSince: (automationId) =>
    [...pending.entries()]
      .filter(([key]) => !automationId || key.startsWith(`${automationId}:`))
      .map(([, v]) => v.enqueuedAt)
      .sort()[0] || null,
  pendingItems: (automationId) =>
    [...pending.entries()]
      .filter(([key]) => !automationId || key.startsWith(`${automationId}:`))
      .map(([, v]) => ({
        automationId: v.automationId,
        entityType: v.entityType,
        trigger: v.trigger,
        collectionId: v.collection?.id,
        collectionName: v.collection?.displayName || v.collection?.singularName,
        itemId: v.item?.id,
        itemName: v.item?.fieldData?.name || v.item?.fieldData?.slug,
        pageId: v.page?.id,
        pageTitle: v.page?.title,
        componentId: v.component?.id,
        componentName: v.component?.name,
        enqueuedAt: v.enqueuedAt,
      }))
      .sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt)),
  lastFlushAt: () => lastFlushAt,
};
