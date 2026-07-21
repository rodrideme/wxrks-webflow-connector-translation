import { useEffect, useRef, useState } from "react";
import api from "../services/api.js";
import { wxrksProjectUrl } from "../wxrksLinks.js";
import { formatDateTime, formatCompactDateTime } from "../formatDate.js";
import Card from "../components/Card.jsx";
import StatusPill from "../components/StatusPill.jsx";
import LoadingState from "../components/LoadingState.jsx";
import { cadenceLabel } from "../runLabels.js";
import { useAuth } from "../context/AuthContext.jsx";

function scopeSummary(contentScope, collections, pageFolders) {
  if (contentScope.scope === "all") return "every collection, page & component";
  const leaves = contentScope.leaves || [];
  if (leaves.length === 0) return "no content selected";
  return leaves
    .map((l) => {
      if (l.kind === "collection") {
        const c = collections.find((c) => c.id === l.id);
        return `collection: ${c ? c.displayName || c.singularName : l.id}`;
      }
      if (l.kind === "pagesFolder") {
        const f = pageFolders.find((f) => f.id === l.id);
        return `folder: ${f ? f.title : l.id}`;
      }
      return "components";
    })
    .join(", ");
}

// wxrks has two redundant webhooks registered against it, so every real
// delivery event produces two near-identical `updates[]` entries (same
// content, `updatedAt` a few seconds apart). This is a display-side-only
// fix -- the underlying race (Webflow genuinely gets written twice) isn't
// being closed here. Generous vs. the seconds-apart gap two redundant
// webhooks actually produce, but short enough that a later, coincidentally
// identical push is never mistaken for the same delivery.
const DUPLICATE_UPDATE_WINDOW_MS = 5 * 60 * 1000;

function dedupWebflowUpdates(updates) {
  const kept = [];
  for (const update of updates) {
    const { updatedAt, ...rest } = update;
    const signature = JSON.stringify(rest);
    const isDuplicate = kept.some(
      (k) => k.signature === signature && Math.abs(new Date(updatedAt) - new Date(k.updatedAt)) <= DUPLICATE_UPDATE_WINDOW_MS
    );
    if (!isDuplicate) kept.push({ signature, updatedAt, update });
  }
  return kept.map((k) => k.update);
}

/**
 * One run's overall delivery status, derived from its own `updates[]` --
 * same "latest attempt per (entity, locale) wins" reduction as
 * store.js's latestUpdateByEntityAndLocale, just computed client-side over
 * data already loaded by GET /history (no extra fetch). "Synced" requires
 * every item/locale to be delivered with zero errors; anything else
 * (still in progress, or any error) is "issues" -- matches the Synced/
 * Issues filter's definition exactly.
 */
function computeRunStatus(batch) {
  const totalExpected = batch.items.length * batch.targetLocales.length;
  const latestByKey = new Map();
  for (const update of dedupWebflowUpdates(batch.updates)) {
    for (const item of update.resultsByItem || []) {
      const entityId = item.webflowComponentId || item.webflowPageId || item.webflowItemId;
      for (const rl of item.resultsByLocale || []) {
        const key = `${entityId}::${rl.locale}`;
        const existing = latestByKey.get(key);
        if (!existing || new Date(update.updatedAt) > new Date(existing.updatedAt)) {
          latestByKey.set(key, { entityId, locale: rl.locale, error: rl.error || null, updatedAt: update.updatedAt });
        }
      }
    }
  }
  const entries = [...latestByKey.values()];
  const errors = entries.filter((e) => e.error);
  const delivered = entries.filter((e) => !e.error);
  const latestDeliveredAt = delivered.reduce(
    (max, e) => (!max || new Date(e.updatedAt) > new Date(max) ? e.updatedAt : max),
    null
  );
  const complete = delivered.length === totalExpected;
  return {
    hasErrors: errors.length > 0,
    errors,
    latestDeliveredAt,
    complete,
    bucket: errors.length > 0 || !complete ? "issues" : "synced",
  };
}

// Mirrors the mockup's own duration() logic: only a real duration once
// every item/locale has been delivered (min(sent) is always batch.createdAt
// uniformly -- confirmed live, GET /work-units stamps every row with the
// same mapping.createdAt -- so no per-row sent timestamp needs tracking).
function formatDuration(createdAt, status) {
  if (!status.complete) return "In progress";
  const mins = Math.round((new Date(status.latestDeliveredAt) - new Date(createdAt)) / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `${hours}h${remMins ? ` ${remMins}m` : ""}`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function langChips(targetLocales) {
  return targetLocales.length > 2 ? [targetLocales[0], `+${targetLocales.length - 1}`] : targetLocales;
}

// Exact stroke-icon paths from the approved Runs page mockup (24x24
// viewBox, stroke="currentColor", no icon library used anywhere else in
// this app -- see Card/StatusPill/Chip, which are all plain markup).
const RUN_ICON_PATHS = {
  search: "M11 4a7 7 0 105.2 11.7L21 21l-4.8-5.3A7 7 0 0011 4z",
  chevron: "M9 6l6 6-6 6",
  alert: "M12 3l10 18H2L12 3zm0 7v4m0 3v.5",
  ext: "M14 4h6v6M20 4L10 14M9 5H5v14h14v-4",
  clock: "M12 3a9 9 0 100 18 9 9 0 000-18zm0 4v5l3 3",
  funnel: "M3 5h18l-7 8v6l-4-2v-4L3 5z",
  calendar: "M8 2v4M16 2v4M3 8h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z",
  file: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6M9 13h6M9 17h6",
};

function RunIcon({ path, size = 14, className = "" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={"flex-none " + className}
    >
      <path d={RUN_ICON_PATHS[path]} />
    </svg>
  );
}

// "Open in wxrks"/"Open in Webflow"/"View live" links -- 12.5px/600, the
// mockup's link color (--runs-link), external-link icon instead of an
// arrow glyph.
function RunExternalLink({ href, onClick, children }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={onClick}
      className="runs-link inline-flex items-center gap-1 whitespace-nowrap text-[12.5px] font-semibold"
    >
      {children}
      <RunIcon path="ext" size={12} />
    </a>
  );
}

// One of the mockup's 4 status variants -- distinct from the shared
// StatusPill component (used elsewhere in this app), since these are
// exact mockup hex values via the --runs-* tokens, not this app's usual
// design-system palette.
function RunStatusPill({ variant, label }) {
  const vars = {
    synced: ["--runs-synced-bg", "--runs-synced-fg", "--runs-synced-dot"],
    error: ["--runs-error-bg", "--runs-error-fg", "--runs-error-dot"],
    partial: ["--runs-partial-bg", "--runs-partial-fg", "--runs-partial-dot"],
    pending: ["--runs-pending-bg", "--runs-pending-fg", "--runs-pending-dot"],
  }[variant] || ["--runs-pending-bg", "--runs-pending-fg", "--runs-pending-dot"];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-2 pr-2.5 text-[11px] font-semibold"
      style={{ backgroundColor: `var(${vars[0]})`, color: `var(${vars[1]})` }}
    >
      <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ backgroundColor: `var(${vars[2]})` }} />
      {label}
    </span>
  );
}

// Lang chip -- uppercase code, --runs-lang-chip-* tokens, 5px radius (not
// quite any of Tailwind's default rounded-* steps).
function RunLangChip({ children }) {
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-semibold uppercase"
      style={{ backgroundColor: "var(--runs-lang-chip-bg)", color: "var(--runs-lang-chip-text)", borderRadius: 5 }}
    >
      {children}
    </span>
  );
}

function ModeIcon({ mode }) {
  const isRecurring = mode === "automation";
  return (
    <span
      title={isRecurring ? "Recurring — re-syncs automatically" : "One-send — sent once"}
      className="inline-flex flex-none"
      style={{ color: "var(--runs-text-faint)" }}
    >
      <RunIcon path={isRecurring ? "calendar" : "file"} size={14} />
    </span>
  );
}

/**
 * Groups GET /work-units' flat (item x locale) rows back into one row per
 * document, keyed by entityId (not workUnitName -- a user-configurable
 * naming pattern isn't guaranteed unique across different documents).
 * Word counts come from the batch's own items[] (already stored server-
 * side), not summed from work-unit rows. The "Open in Webflow" link uses
 * the first target locale's link -- a deliberate simplification, since the
 * real URL can differ per locale (locale subdirectories) but the other
 * locales are already visible via the Languages column.
 */
function groupWorkUnitsByDocument(workUnits, batch) {
  const wordCountByEntityId = new Map(
    batch.items.map((i) => [i.webflowItemId || i.webflowPageId || i.webflowComponentId, i.wordCount || 0])
  );
  const byEntity = new Map();
  for (const row of workUnits) {
    if (!byEntity.has(row.entityId)) {
      byEntity.set(row.entityId, {
        entityId: row.entityId,
        workUnitName: row.workUnitName,
        words: wordCountByEntityId.get(row.entityId) || 0,
        locales: [],
        latestUpdatedAt: null,
        hasError: false,
        allDelivered: true,
        link: null,
      });
    }
    const doc = byEntity.get(row.entityId);
    doc.locales.push(row.targetLocale);
    if (row.updateError) doc.hasError = true;
    if (!row.updatedOnWebflowAt) doc.allDelivered = false;
    else if (!doc.latestUpdatedAt || new Date(row.updatedOnWebflowAt) > new Date(doc.latestUpdatedAt)) {
      doc.latestUpdatedAt = row.updatedOnWebflowAt;
    }
    if (!doc.link && row.webflowUrl) doc.link = { url: row.webflowUrl, type: row.linkType };
  }
  return [...byEntity.values()];
}

// "not_registered" is a normal, expected state (no automation needs this
// webhook yet) -- only "deactivated"/other unexpected statuses get an actual
// Reregister action, since that's the only case something is really broken.
function webhookPill(status, label, onReregister, busy, canEdit) {
  if (status === "active") return <StatusPill variant="success" label={`${label} healthy`} />;
  if (status === "not_registered") return <StatusPill variant="draft" label={`${label} not registered`} />;
  return (
    <span className="inline-flex items-center gap-2">
      <StatusPill variant="error" label={`${label} ${status.replace("_", " ")}`} />
      <button
        type="button"
        onClick={onReregister}
        disabled={busy || !canEdit}
        title={!canEdit ? "Your account has read-only access." : undefined}
        className="text-[11px] font-semibold text-accent-text hover:underline disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Reregistering…" : "Reregister"}
      </button>
    </span>
  );
}

// GET /api/sync/history's paginated mode (see api.js's getSyncHistory) --
// no total-count query, so "a full page came back" is the only signal
// there might be more; the Load more button disappears once a page comes
// back short.
const HISTORY_PAGE_SIZE = 10;

const TABS = [
  ["history", "History"],
  ["recurring", "Recurring Automation"],
  ["pending", "Pending Queue"],
];

// Dashboard's "Running automations" widget deep-links to /runs#automation-<id>;
// its "Recent runs" widget deep-links to /runs#<wxrksProjectUUID> instead --
// land on whichever tab actually holds that element so the scroll-into-view
// effect below has something to find.
function initialTabFromHash() {
  return window.location.hash.startsWith("#automation-") ? "recurring" : "history";
}

export default function Runs() {
  const { canEdit } = useAuth();
  const [automations, setAutomations] = useState(null);
  const [pendingItems, setPendingItems] = useState([]);
  const [webhook, setWebhook] = useState(null);
  const [pagesWebhook, setPagesWebhook] = useState(null);
  const [history, setHistory] = useState(null);
  const [collections, setCollections] = useState([]);
  const [pageFolders, setPageFolders] = useState([]);
  const [orgUnits, setOrgUnits] = useState([]);
  const [timezone, setTimezone] = useState(undefined);
  const [activeTab, setActiveTab] = useState(initialTabFromHash);
  const [historySearch, setHistorySearch] = useState("");
  const [historyStatusFilter, setHistoryStatusFilter] = useState("all"); // all | synced | issues
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [detailAutomation, setDetailAutomation] = useState(null);
  const [flushing, setFlushing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reregistering, setReregistering] = useState(null); // "cms" | "pages" | null
  const [error, setError] = useState(null);
  const [expandedRuns, setExpandedRuns] = useState({}); // { [wxrksProjectUUID]: true }
  const [workUnitsByRun, setWorkUnitsByRun] = useState({}); // { [wxrksProjectUUID]: rows[] | "loading" | "error" }
  // Caches the actual in-flight/settled promise per run, checked
  // synchronously (unlike workUnitsByRun state, which only updates on the
  // next render) -- needed because React.StrictMode's dev-only
  // double-invoke of the mount effect calls loadWorkUnitsForBatches twice
  // back to back. A boolean-only guard would make the second invocation's
  // "already dispatched" check return an instantly-resolved dummy promise
  // instead of the real one, so a batch-level `await` could resolve (and
  // reveal the run list) before that run's actual fetch had settled.
  // Returning the SAME real promise to every caller for a given run fixes
  // both problems at once: no duplicate fetches, and every awaiter --
  // regardless of which invocation dispatched it -- only resolves once the
  // real data (or error) is in.
  const dispatchedRunsRef = useRef(new Map());
  // uuids of whichever batch is currently being eager-loaded (initial page,
  // "load more" page, or a fresh search page); null once settled. Progress
  // is derived from real workUnitsByRun state below (not an imperative
  // counter) so it can't be thrown off by React.StrictMode's dev-only
  // double-invoke of the mount effect dispatching the same batch twice.
  const [eagerBatchUuids, setEagerBatchUuids] = useState(null); // string[] | null
  const eagerBatchProgress = eagerBatchUuids && {
    total: eagerBatchUuids.length,
    done: eagerBatchUuids.filter((uuid) => workUnitsByRun[uuid] && workUnitsByRun[uuid] !== "loading").length,
  };

  // GET /work-units has no server-side or fetch-level timeout, so a single
  // hung upstream Webflow call used to only stall that one card's spinner.
  // Now that the whole page gates on every run in the batch settling (see
  // loadWorkUnitsForBatches), one hung request would otherwise block the
  // entire list from ever appearing -- this bounds that risk without
  // touching the shared api.js request() helper other callers rely on.
  const WORK_UNITS_TIMEOUT_MS = 20000;

  function loadRunWorkUnits(wxrksProjectUUID) {
    if (dispatchedRunsRef.current.has(wxrksProjectUUID)) return dispatchedRunsRef.current.get(wxrksProjectUUID);
    setWorkUnitsByRun((prev) => ({ ...prev, [wxrksProjectUUID]: "loading" }));
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out")), WORK_UNITS_TIMEOUT_MS));
    const promise = Promise.race([api.getRunWorkUnits(wxrksProjectUUID), timeout])
      .then((res) => setWorkUnitsByRun((prev) => ({ ...prev, [wxrksProjectUUID]: res.rows || [] })))
      .catch(() => setWorkUnitsByRun((prev) => ({ ...prev, [wxrksProjectUUID]: "error" })));
    dispatchedRunsRef.current.set(wxrksProjectUUID, promise);
    return promise;
  }

  function toggleRunWorkUnits(wxrksProjectUUID) {
    const nowExpanded = !expandedRuns[wxrksProjectUUID];
    setExpandedRuns((prev) => ({ ...prev, [wxrksProjectUUID]: nowExpanded }));
    if (nowExpanded) loadRunWorkUnits(wxrksProjectUUID);
  }

  // Eager-loads a whole loaded page's documents (see the mount effect,
  // loadMoreHistory, and the search effect below) at a bounded concurrency
  // -- GET /work-units does real, non-trivial live Webflow work per run:
  // getSiteLocales() plus one listAllItems() call per distinct
  // (collection, locale) pair the run touches (itself paginated for large
  // collections), plus a page-folders fetch. A single run can already fan
  // out to several real Webflow API calls, so this is NOT a 1:1 comparison
  // to automationScheduler.js's SCAN_CONCURRENCY=8 (which bounds calls that
  // each make only 1-2 Webflow requests) -- confirmed live that 8 here
  // fanned out past the ~40-rapid-request threshold documented in
  // webflow.js's 429-retry interceptor, causing card 2 onward to
  // genuinely error under real account data. Kept low enough that even a
  // page of runs each touching several collections/locales stays clear of
  // that threshold.
  const EAGER_LOAD_CONCURRENCY = 3;
  async function loadWorkUnitsForBatches(batches) {
    setEagerBatchUuids(batches.map((b) => b.wxrksProjectUUID));
    let index = 0;
    async function worker() {
      while (index < batches.length) {
        const batch = batches[index++];
        await loadRunWorkUnits(batch.wxrksProjectUUID);
      }
    }
    await Promise.all(Array.from({ length: Math.min(EAGER_LOAD_CONCURRENCY, batches.length) }, worker));
    setEagerBatchUuids(null);
  }

  function loadMoreHistory() {
    setLoadingMoreHistory(true);
    const search = historySearch.trim() || undefined;
    api
      .getSyncHistory({ limit: HISTORY_PAGE_SIZE, offset: historyOffset, search })
      .then(async (res) => {
        const more = res.history || [];
        // Documents are eager-loaded before these rows join the visible
        // list -- by the time they appear, every card opens instantly. The
        // "Load more" button's own "Loading…" label already covers this
        // whole span (see loadingMoreHistory below), not just the list fetch.
        await loadWorkUnitsForBatches(more);
        setHistory((prev) => [...(prev || []), ...more]);
        setHistoryOffset((prev) => prev + more.length);
        setHistoryHasMore(more.length === HISTORY_PAGE_SIZE);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoadingMoreHistory(false));
  }

  function loadAutomations() {
    setRefreshing(true);
    return api
      .listAutomations()
      .then((res) => {
        setAutomations(res.automations || []);
        setPendingItems(res.pendingItems || []);
        setWebhook(res.webhook);
        setPagesWebhook(res.pagesWebhook);
      })
      .catch((err) => setError(err.message))
      .finally(() => setRefreshing(false));
  }

  useEffect(() => {
    loadAutomations();
    const interval = setInterval(loadAutomations, 8000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    Promise.all([
      api.getSyncHistory({ limit: HISTORY_PAGE_SIZE, offset: 0 }),
      api.getCollections().catch(() => ({ collections: [] })),
      api.getPageFolders().catch(() => ({ folders: [] })),
      api.getOrgUnits().catch(() => ({ orgUnits: [] })),
      api.getSettings().catch(() => null),
    ])
      .then(async ([historyRes, collectionsRes, foldersRes, orgUnitsRes, settingsRes]) => {
        const history = historyRes.history || [];
        setCollections(collectionsRes.collections || []);
        setPageFolders(foldersRes.folders || []);
        setOrgUnits(orgUnitsRes.orgUnits || []);
        setTimezone(settingsRes?.timezone);
        // Documents are eager-loaded before the list becomes visible at all
        // -- the page shows one loading indicator (see the history === null
        // render branch) until every run's documents are ready, so by the
        // time a user sees any card, expanding it is instant.
        await loadWorkUnitsForBatches(history);
        setHistory(history);
        setHistoryOffset(history.length);
        setHistoryHasMore(history.length === HISTORY_PAGE_SIZE);
        // The most recent run (history is already most-recent-first) starts
        // expanded -- every other run in this page stays visually collapsed.
        if (history.length > 0) {
          setExpandedRuns((prev) => ({ ...prev, [history[0].wxrksProjectUUID]: true }));
        }
      })
      .catch((err) => setError(err.message));
  }, []);

  // Server-side search (see GET /sync/history's `search` param) -- a
  // client-side-only filter would silently miss any match sitting on a
  // page that hasn't been loaded yet. Debounced so it doesn't re-fetch on
  // every keystroke; skips the very first render, since the mount effect
  // above already did the initial (no-search) fetch. The cleanup resets the
  // ref rather than leaving it flipped -- React.StrictMode's dev-only
  // double-invoke of the mount cycle runs this effect twice back to back;
  // without undoing the flip, the second invocation would see "not first"
  // and fire a spurious extra search fetch (with an empty query) during
  // ordinary page load, racing the real mount effect's own eager-load.
  const isFirstSearchRender = useRef(true);
  useEffect(() => {
    if (isFirstSearchRender.current) {
      isFirstSearchRender.current = false;
      return () => {
        isFirstSearchRender.current = true;
      };
    }
    const search = historySearch.trim() || undefined;
    const handle = setTimeout(() => {
      setHistory(null);
      setHistoryOffset(0);
      setHistoryHasMore(false);
      api
        .getSyncHistory({ limit: HISTORY_PAGE_SIZE, offset: 0, search })
        .then(async (res) => {
          const page = res.history || [];
          // Same gate as the mount effect -- documents are ready before the
          // list (re)appears, so the page-level loading indicator covers
          // the whole search transition, not just the list refetch.
          await loadWorkUnitsForBatches(page);
          setHistory(page);
          setHistoryOffset(page.length);
          setHistoryHasMore(page.length === HISTORY_PAGE_SIZE);
        })
        .catch((err) => setError(err.message));
    }, 300);
    return () => clearTimeout(handle);
  }, [historySearch]);

  // Deep-link support: /logs#<wxrksProjectUUID> or /runs#automation-<id>
  // scrolls straight to that card/row (used by the Dashboard's runs and
  // running-automations summaries). Route itself now redirects to /runs,
  // so the hash still lands here. Depends on both history and automations
  // since either could be the element the hash is targeting, and each
  // loads via its own effect/poll.
  useEffect(() => {
    if ((!history && !automations) || !window.location.hash) return;
    const el = document.getElementById(window.location.hash.slice(1));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [history, automations]);

  function orgUnitName(uuid) {
    const o = orgUnits.find((o) => o.uuid === uuid);
    return o ? o.name : uuid;
  }
  function automationName(id) {
    return (automations || []).find((a) => a.id === id)?.name;
  }

  async function togglePause(a) {
    try {
      await (a.enabled ? api.pauseAutomation(a.id) : api.resumeAutomation(a.id));
      loadAutomations();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleArchive(a) {
    try {
      await (a.archived ? api.unarchiveAutomation(a.id) : api.archiveAutomation(a.id));
      loadAutomations();
    } catch (err) {
      setError(err.message);
    }
  }

  async function reregisterWebhook(kind) {
    setReregistering(kind);
    try {
      await (kind === "cms" ? api.reregisterAutoSyncWebhook() : api.reregisterPagesWebhook());
      loadAutomations();
    } catch (err) {
      setError(err.message);
    } finally {
      setReregistering(null);
    }
  }

  async function flushAll() {
    setFlushing(true);
    try {
      await api.flushAllAutomations();
      loadAutomations();
    } catch (err) {
      setError(err.message);
    } finally {
      setFlushing(false);
    }
  }

  const historyBuckets = (history || []).map((batch) => ({ batch, status: computeRunStatus(batch) }));
  const historyStatusCounts = {
    all: historyBuckets.length,
    synced: historyBuckets.filter((h) => h.status.bucket === "synced").length,
    issues: historyBuckets.filter((h) => h.status.bucket === "issues").length,
  };
  // Search itself is server-side now (see the debounced effect above) --
  // `history` already only contains matches, so this only still applies
  // the status filter, which (unlike search) stays scoped to whatever
  // page is currently loaded.
  const filteredHistory = historyBuckets.filter(
    ({ status }) => historyStatusFilter === "all" || status.bucket === historyStatusFilter
  );

  const archivedCount = (automations || []).filter((a) => a.archived).length;
  const visibleAutomations = (automations || []).filter((a) => showArchived || !a.archived);

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Runs</h1>
        <p className="mt-0.5 text-[13px] text-ink-faint">Recurring automations, their pending queue, and every past translation run.</p>
      </div>

      {error && <p className="mb-4 text-sm font-medium text-status-error-fg">Error: {error}</p>}

      <div className="mb-5 flex gap-1 border-b border-border">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            onClick={() => setActiveTab(value)}
            className={
              "-mb-px border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors " +
              (activeTab === value ? "border-accent text-ink" : "border-transparent text-ink-faint hover:text-ink")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "recurring" && (
      <>
      {/* Recurring automations */}
      <Card className="mb-4">
        <div className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
          <span className="text-[13px] font-semibold text-ink">Recurring automations</span>
          <div className="flex items-center gap-3">
            {archivedCount > 0 && (
              <button
                onClick={() => setShowArchived((v) => !v)}
                className="text-[11.5px] font-semibold text-accent-text hover:underline"
              >
                {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
              </button>
            )}
            <span className="text-[11.5px] text-ink-faint">Created from Translate → Send</span>
          </div>
        </div>
        {automations === null ? (
          <p className="p-4 text-sm text-ink-faint">Loading…</p>
        ) : automations.length === 0 ? (
          <p className="p-4 text-sm text-ink-faint">No automations yet — create one from Translate → Send.</p>
        ) : visibleAutomations.length === 0 ? (
          <p className="p-4 text-sm text-ink-faint">All automations are archived — click "Show archived" to view them.</p>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[46rem]">
              {visibleAutomations.map((a) => (
                <div
                  key={a.id}
                  id={`automation-${a.id}`}
                  onClick={() => setDetailAutomation(a)}
                  className="grid cursor-pointer grid-cols-[1fr_140px_100px_auto] items-center gap-4 border-t border-border px-4 py-3 first:border-t-0 hover:bg-surface-sunken"
                  style={{ opacity: a.archived ? 0.55 : 1 }}
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-medium text-ink">{a.name}</div>
                    <div className="truncate font-mono text-[11px] text-ink-faint">{scopeSummary(a.contentScope, collections, pageFolders)}</div>
                    <div className="truncate text-[11px] text-ink-faint">
                      Project name:{" "}
                      <span className="font-mono">{a.projectName || `Automation "${a.name}" · <send time>`}</span>
                    </div>
                  </div>
                  <span className="font-mono text-xs text-ink-soft">{cadenceLabel(a.cadence)}</span>
                  <span className="flex items-center gap-1.5 text-[11.5px] font-semibold">
                    {a.archived ? (
                      <StatusPill variant="draft" label="Archived" />
                    ) : a.enabled ? (
                      <StatusPill variant="success" label="Running" />
                    ) : (
                      <StatusPill variant="draft" label="Paused" />
                    )}
                  </span>
                  <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                    {!a.archived && (
                      <button
                        onClick={() => togglePause(a)}
                        disabled={!canEdit}
                        title={!canEdit ? "Your account has read-only access." : undefined}
                        className="rounded-md border border-border-strong bg-surface px-2.5 py-1 text-xs font-semibold hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {a.enabled ? "Pause" : "Resume"}
                      </button>
                    )}
                    <button
                      onClick={() => toggleArchive(a)}
                      disabled={!canEdit}
                      title={!canEdit ? "Your account has read-only access." : undefined}
                      className="rounded-md border border-border-strong bg-surface px-2.5 py-1 text-xs font-semibold hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {a.archived ? "Unarchive" : "Archive"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {(webhook || pagesWebhook) && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          {webhook && webhookPill(webhook.status, "CMS webhook", () => reregisterWebhook("cms"), reregistering === "cms", canEdit)}
          {pagesWebhook && pagesWebhook.status !== "not_registered" &&
            webhookPill(pagesWebhook.status, "Pages/Components publish webhook", () => reregisterWebhook("pages"), reregistering === "pages", canEdit)}
        </div>
      )}
      </>
      )}

      {activeTab === "pending" && (
      <>
      {/* Pending queue */}
      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-status-auto-dot" />
            Pending queue
            <button
              onClick={loadAutomations}
              disabled={refreshing}
              className="ml-1 text-[11.5px] font-semibold text-accent-text hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </span>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] text-ink-faint">
              {pendingItems.length} items · {pendingItems.reduce((s, p) => s + (p.wordCount || 0), 0).toLocaleString()} words
            </span>
            <button
              onClick={flushAll}
              disabled={flushing || pendingItems.length === 0 || !canEdit}
              title={!canEdit ? "Your account has read-only access." : undefined}
              className="rounded-md border border-border-strong bg-surface px-3 py-1.5 text-xs font-semibold hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-50"
            >
              {flushing ? "Sending…" : "Translate queue now"}
            </button>
          </div>
        </div>
        {pendingItems.length === 0 ? (
          <p className="p-6 text-center text-sm text-ink-faint">
            Queue is empty. New and edited items appear here as Webflow webhooks arrive, then run under their automation.
          </p>
        ) : (
          pendingItems.map((p, i) => (
            <div key={i} className="flex items-center gap-4 border-t border-border px-4 py-2.5 text-sm first:border-t-0">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-ink">{p.itemName || p.pageTitle || p.componentName}</div>
                <div className="truncate text-[11px] text-ink-faint">
                  {p.collectionName || p.entityType}
                  {automationName(p.automationId) && <> &middot; caught by <span className="text-ink-soft">{automationName(p.automationId)}</span></>}
                </div>
              </div>
              <span className="rounded-full bg-status-auto-bg px-2.5 py-0.5 text-[11px] font-semibold text-status-auto-fg">{p.trigger}</span>
              <span className="font-mono text-[11.5px] text-ink-faint">{formatDateTime(p.enqueuedAt, timezone)}</span>
            </div>
          ))
        )}
      </Card>
      </>
      )}

      {activeTab === "history" && (
      <div style={{ fontFamily: "'Instrument Sans', system-ui, sans-serif" }}>
      {/* History */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative max-w-[340px] flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--runs-text-faint)" }}>
            <RunIcon path="search" size={15} />
          </span>
          <input
            type="text"
            value={historySearch}
            onChange={(e) => setHistorySearch(e.target.value)}
            placeholder="Search projects…"
            className="w-full py-2 pl-9 pr-3 text-[13.5px] outline-none"
            style={{
              borderRadius: 9,
              border: "1px solid var(--runs-search-border)",
              backgroundColor: "var(--runs-card-bg)",
              color: "var(--runs-text-primary)",
            }}
          />
        </div>
        <div className="flex gap-1.5">
          {[
            ["all", "All"],
            ["synced", "Synced"],
            ["issues", "Issues"],
          ].map(([value, label]) => {
            const active = historyStatusFilter === value;
            return (
              <button
                key={value}
                onClick={() => setHistoryStatusFilter(value)}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-medium"
                style={{
                  backgroundColor: active ? "var(--runs-filter-active-bg)" : "var(--runs-card-bg)",
                  color: active ? "var(--runs-filter-active-text)" : "var(--runs-filter-inactive-text)",
                  border: `1px solid ${active ? "var(--runs-filter-active-bg)" : "var(--runs-search-border)"}`,
                }}
              >
                {label}
                <span className="tabular-nums opacity-70">{historyStatusCounts[value]}</span>
              </button>
            );
          })}
        </div>
        <span className="ml-auto whitespace-nowrap text-[12.5px]" style={{ color: "#8a8a94" }}>
          {filteredHistory.length} of {(history || []).length} runs
        </span>
      </div>

      {history === null ? (
        <LoadingState
          label={
            eagerBatchProgress
              ? `Loading ${eagerBatchProgress.done} of ${eagerBatchProgress.total} run${eagerBatchProgress.total === 1 ? "" : "s"}…`
              : "Loading history…"
          }
        />
      ) : filteredHistory.length === 0 ? (
        <div
          className="p-6 text-center text-sm"
          style={{ backgroundColor: "var(--runs-card-bg)", border: "1px solid var(--runs-card-border)", borderRadius: 12, color: "var(--runs-text-faint)" }}
        >
          {historySearch.trim() ? `No runs match "${historySearch.trim()}"` : "No runs of this type yet."}
        </div>
      ) : (
        <>
        <div
          className="mb-2 hidden items-center gap-2.5 px-3.5 text-[11px] font-semibold uppercase tracking-[0.06em] sm:flex"
          style={{ color: "var(--runs-text-faint)" }}
        >
          <span className="w-3.5 flex-none" />
          <span className="min-w-0 flex-1">Project</span>
          <span className="w-[30px] flex-none text-right">Docs</span>
          <span className="w-12 flex-none text-right">Words</span>
          <span className="w-[72px] flex-none">Langs</span>
          <span className="w-[86px] flex-none">Works</span>
          <span className="w-[86px] flex-none">Webflow</span>
          <span className="w-[66px] flex-none text-right">Status</span>
        </div>
        <div className="flex flex-col gap-2">
          {filteredHistory.map(({ batch, status }) => {
            const isOpen = Boolean(expandedRuns[batch.wxrksProjectUUID]);
            const workUnits = workUnitsByRun[batch.wxrksProjectUUID];
            const documents = Array.isArray(workUnits) ? groupWorkUnitsByDocument(workUnits, batch) : null;
            const wordCount = batch.items.reduce((sum, i) => sum + (i.wordCount || 0), 0);
            const runVariant = status.hasErrors ? "error" : status.complete ? "synced" : "pending";
            const runLabel = status.hasErrors ? "Issues" : status.complete ? "Synced" : "Pending";
            return (
              <div
                key={batch.wxrksProjectUUID}
                id={batch.wxrksProjectUUID}
                style={{
                  backgroundColor: "var(--runs-card-bg)",
                  border: `1px solid ${status.hasErrors ? "var(--runs-card-border-error)" : "var(--runs-card-border)"}`,
                  borderRadius: 12,
                  boxShadow: "0 1px 2px rgba(23,23,28,0.04)",
                  overflow: "hidden",
                }}
              >
                <div
                  onClick={() => toggleRunWorkUnits(batch.wxrksProjectUUID)}
                  className="flex flex-wrap items-center gap-2.5 cursor-pointer"
                  style={{ padding: 14 }}
                >
                  <span
                    className="flex-none transition-transform"
                    style={{ color: "var(--runs-text-faint)", transform: isOpen ? "rotate(90deg)" : undefined }}
                  >
                    <RunIcon path="chevron" size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      {batch.reference ? (
                        <span className="truncate text-[14px] font-semibold" style={{ color: "var(--runs-text-primary)" }}>
                          {batch.reference}
                        </span>
                      ) : (
                        <span
                          className="truncate text-[14px]"
                          style={{ color: "var(--runs-text-muted)", fontFamily: "'JetBrains Mono', monospace" }}
                        >
                          {batch.wxrksProjectUUID}
                        </span>
                      )}
                      <ModeIcon mode={batch.mode} />
                      <RunExternalLink href={wxrksProjectUrl(batch.wxrksProjectUUID)} onClick={(e) => e.stopPropagation()}>
                        Open in wxrks
                      </RunExternalLink>
                    </div>
                  </div>
                  <span className="w-[30px] flex-none text-right text-[13px] tabular-nums" style={{ color: "var(--runs-text-secondary)" }}>
                    {batch.items.length}
                  </span>
                  <span className="w-12 flex-none text-right text-[13px] tabular-nums" style={{ color: "var(--runs-text-secondary)" }}>
                    {wordCount.toLocaleString()}
                  </span>
                  <span className="flex w-[72px] flex-none flex-wrap gap-1">
                    {langChips(batch.targetLocales).map((l) => (
                      <RunLangChip key={l}>{l}</RunLangChip>
                    ))}
                  </span>
                  <span className="w-[86px] flex-none text-[11.5px]" style={{ color: "var(--runs-text-muted)" }}>
                    {formatCompactDateTime(batch.createdAt, timezone)}
                  </span>
                  <span className="w-[86px] flex-none text-[11.5px]" style={{ color: "var(--runs-text-muted)" }}>
                    {status.latestDeliveredAt ? formatCompactDateTime(status.latestDeliveredAt, timezone) : "—"}
                  </span>
                  <span className="w-[66px] flex-none text-right">
                    <RunStatusPill variant={runVariant} label={runLabel} />
                  </span>
                </div>

                {isOpen && (
                  <div
                    style={{
                      borderTop: "1px solid var(--runs-expanded-border)",
                      backgroundColor: "var(--runs-expanded-bg)",
                      padding: 16,
                      overflowX: "auto",
                    }}
                  >
                    <div
                      className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-[12.5px]"
                      style={{ color: "var(--runs-text-muted)" }}
                    >
                      {batch.contentScope && (
                        <span className="inline-flex items-center gap-1.5">
                          <RunIcon path="funnel" size={13} />
                          Sync criteria:{" "}
                          <strong className="font-semibold" style={{ color: "var(--runs-text-primary)" }}>
                            {scopeSummary(batch.contentScope, collections, pageFolders)}
                          </strong>
                        </span>
                      )}
                      <span
                        className="ml-auto inline-flex items-center gap-1.5"
                        title="First file sent to wxrks until last file updated on Webflow"
                      >
                        <RunIcon path="clock" size={13} />
                        Time to translate:{" "}
                        <strong className="font-semibold" style={{ color: "var(--runs-text-primary)" }}>
                          {formatDuration(batch.createdAt, status)}
                        </strong>
                      </span>
                    </div>

                    {status.hasErrors && (
                      <div
                        className="mb-3 flex flex-col gap-1.5 text-[13px]"
                        style={{
                          backgroundColor: "var(--runs-error-banner-bg)",
                          border: "1px solid var(--runs-error-banner-border)",
                          borderRadius: 9,
                          padding: 12,
                          color: "var(--runs-error-banner-fg)",
                        }}
                      >
                        {status.errors.map((e, i) => (
                          <div key={i} className="flex items-start gap-2">
                            <RunIcon path="alert" size={13} className="mt-0.5" />
                            <div>
                              <span>
                                {e.entityId} ({e.locale})
                              </span>
                              <div
                                className="mt-0.5 rounded px-2 py-1 font-mono text-[11.5px]"
                                style={{ backgroundColor: "var(--runs-card-bg)" }}
                              >
                                {e.error}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {workUnits === "loading" || workUnits === undefined ? (
                      // Structurally unreachable in normal use -- a run only
                      // ever appears in the list once its batch's eager
                      // doc-load has already settled (see the history ===
                      // null gate above). Kept as a defensive fallback only.
                      <p className="text-sm" style={{ color: "var(--runs-text-faint)" }}>
                        Loading documents...
                      </p>
                    ) : workUnits === "error" ? (
                      <p className="text-sm" style={{ color: "var(--runs-error-fg)" }}>
                        Couldn't load documents for this run.
                      </p>
                    ) : documents.length === 0 ? (
                      <p className="text-sm" style={{ color: "var(--runs-text-faint)" }}>
                        No documents in this run.
                      </p>
                    ) : (
                      <div
                        className="overflow-x-auto"
                        style={{ backgroundColor: "var(--runs-card-bg)", border: "1px solid var(--runs-card-border)", borderRadius: 9 }}
                      >
                        <table className="w-full text-left text-[13px]">
                          <thead>
                            <tr
                              className="text-[11px] font-semibold uppercase tracking-wide"
                              style={{ borderBottom: "1px solid var(--runs-card-border)", color: "var(--runs-text-faint)" }}
                            >
                              <th className="px-3 py-2">Document</th>
                              <th className="px-3 py-2 text-right">Words</th>
                              <th className="px-3 py-2">Languages</th>
                              <th className="px-3 py-2">Updated on Works</th>
                              <th className="px-3 py-2">Updated on Webflow</th>
                              <th className="px-3 py-2">Status</th>
                              <th className="px-3 py-2" />
                            </tr>
                          </thead>
                          <tbody>
                            {documents.map((doc, i) => {
                              const docVariant = doc.hasError ? "error" : doc.allDelivered ? "synced" : "pending";
                              const docLabel = doc.hasError ? "Error" : doc.allDelivered ? "Synced" : "Pending";
                              return (
                                <tr key={doc.entityId} style={{ borderTop: i === 0 ? undefined : "1px solid var(--runs-row-divider)" }}>
                                  <td className="px-3 py-2" style={{ color: "var(--runs-text-primary)" }}>
                                    {doc.workUnitName}
                                  </td>
                                  <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--runs-text-secondary)" }}>
                                    {doc.words.toLocaleString()}
                                  </td>
                                  <td className="px-3 py-2 uppercase" style={{ color: "var(--runs-text-secondary)" }}>
                                    {doc.locales.join(", ")}
                                  </td>
                                  <td className="px-3 py-2" style={{ color: "var(--runs-text-secondary)" }}>
                                    {formatCompactDateTime(batch.createdAt, timezone)}
                                  </td>
                                  <td className="px-3 py-2" style={{ color: "var(--runs-text-secondary)" }}>
                                    {doc.latestUpdatedAt ? (
                                      formatCompactDateTime(doc.latestUpdatedAt, timezone)
                                    ) : (
                                      <span style={{ color: "var(--runs-text-faint)" }}>—</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2">
                                    <RunStatusPill variant={docVariant} label={docLabel} />
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-2 text-right">
                                    {doc.link ? (
                                      <RunExternalLink href={doc.link.url}>
                                        {doc.link.type === "published" ? "View live" : "Open in Designer"}
                                      </RunExternalLink>
                                    ) : (
                                      <span style={{ color: "var(--runs-text-faint)" }}>—</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </>
      )}

      {historyHasMore && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={loadMoreHistory}
            disabled={loadingMoreHistory}
            className="rounded-md px-4 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            style={{ border: "1px solid var(--runs-search-border)", backgroundColor: "var(--runs-card-bg)", color: "var(--runs-text-secondary)" }}
          >
            {loadingMoreHistory ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
      </div>
      )}

      {detailAutomation && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ backgroundColor: "rgba(10, 11, 20, 0.55)" }}
          onClick={() => setDetailAutomation(null)}
        >
          <div className="w-full max-w-md rounded-lg border border-border bg-surface shadow-card" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <div className="text-[15px] font-semibold text-ink">{detailAutomation.name}</div>
                <div className="font-mono text-xs text-ink-faint">{scopeSummary(detailAutomation.contentScope, collections, pageFolders)}</div>
              </div>
              <button onClick={() => setDetailAutomation(null)} className="text-ink-faint hover:text-ink">
                ✕
              </button>
            </div>
            <div className="grid grid-cols-[96px_1fr] gap-y-2.5 px-5 py-4 text-[13px]">
              <span className="font-semibold text-ink-faint">Schedule</span>
              <span>{cadenceLabel(detailAutomation.cadence)}</span>
              <span className="font-semibold text-ink-faint">Org unit</span>
              <span>{detailAutomation.orgUnitOverride ? orgUnitName(detailAutomation.orgUnitOverride) : "(global default)"}</span>
              <span className="font-semibold text-ink-faint">Target locales</span>
              <span>{detailAutomation.targetLocalesOverride?.length ? detailAutomation.targetLocalesOverride.join(", ") : "(global default)"}</span>
              <span className="font-semibold text-ink-faint">Workflow</span>
              <span>{detailAutomation.workflows.join(" → ")}</span>
            </div>
            <div className="flex justify-end border-t border-border px-5 py-3">
              <button onClick={() => setDetailAutomation(null)} className="rounded-md border border-border-strong bg-surface px-4 py-1.5 text-sm font-semibold hover:border-ink-faint">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
