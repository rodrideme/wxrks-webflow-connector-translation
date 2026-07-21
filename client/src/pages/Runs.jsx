import { useEffect, useState } from "react";
import api from "../services/api.js";
import { wxrksProjectUrl } from "../wxrksLinks.js";
import { formatDateTime } from "../formatDate.js";
import Card from "../components/Card.jsx";
import StatusPill from "../components/StatusPill.jsx";
import Chip from "../components/Chip.jsx";
import { cadenceLabel } from "../runLabels.js";
import { useAuth } from "../context/AuthContext.jsx";

const linkClass = "font-medium text-accent-text hover:underline";

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
  const [logType, setLogType] = useState("all"); // all | one-time | recurring
  const [historySearch, setHistorySearch] = useState("");
  const [historyStatusFilter, setHistoryStatusFilter] = useState("all"); // all | synced | issues
  const [showArchived, setShowArchived] = useState(false);
  const [detailAutomation, setDetailAutomation] = useState(null);
  const [flushing, setFlushing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reregistering, setReregistering] = useState(null); // "cms" | "pages" | null
  const [error, setError] = useState(null);
  const [expandedRuns, setExpandedRuns] = useState({}); // { [wxrksProjectUUID]: true }
  const [workUnitsByRun, setWorkUnitsByRun] = useState({}); // { [wxrksProjectUUID]: rows[] | "loading" | "error" }

  function loadRunWorkUnits(wxrksProjectUUID) {
    if (workUnitsByRun[wxrksProjectUUID]) return; // already fetched/fetching
    setWorkUnitsByRun((prev) => ({ ...prev, [wxrksProjectUUID]: "loading" }));
    api
      .getRunWorkUnits(wxrksProjectUUID)
      .then((res) => setWorkUnitsByRun((prev) => ({ ...prev, [wxrksProjectUUID]: res.rows || [] })))
      .catch(() => setWorkUnitsByRun((prev) => ({ ...prev, [wxrksProjectUUID]: "error" })));
  }

  function toggleRunWorkUnits(wxrksProjectUUID) {
    const nowExpanded = !expandedRuns[wxrksProjectUUID];
    setExpandedRuns((prev) => ({ ...prev, [wxrksProjectUUID]: nowExpanded }));
    if (nowExpanded) loadRunWorkUnits(wxrksProjectUUID);
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
      api.getSyncHistory(),
      api.getCollections().catch(() => ({ collections: [] })),
      api.getPageFolders().catch(() => ({ folders: [] })),
      api.getOrgUnits().catch(() => ({ orgUnits: [] })),
      api.getSettings().catch(() => null),
    ])
      .then(([historyRes, collectionsRes, foldersRes, orgUnitsRes, settingsRes]) => {
        const history = historyRes.history || [];
        setHistory(history);
        setCollections(collectionsRes.collections || []);
        setPageFolders(foldersRes.folders || []);
        setOrgUnits(orgUnitsRes.orgUnits || []);
        setTimezone(settingsRes?.timezone);
        // The most recent run (history is already most-recent-first) starts
        // expanded, fetching its work units immediately -- every other run
        // stays collapsed until manually expanded.
        if (history.length > 0) {
          const mostRecentUUID = history[0].wxrksProjectUUID;
          setExpandedRuns((prev) => ({ ...prev, [mostRecentUUID]: true }));
          loadRunWorkUnits(mostRecentUUID);
        }
      })
      .catch((err) => setError(err.message));
  }, []);

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
  const historySearchTerm = historySearch.trim().toLowerCase();
  const filteredHistory = historyBuckets.filter(({ batch, status }) => {
    if (logType !== "all") {
      const type = batch.mode === "automation" ? "recurring" : "one-time";
      if (type !== logType) return false;
    }
    if (historyStatusFilter !== "all" && status.bucket !== historyStatusFilter) return false;
    if (historySearchTerm && !(batch.reference || batch.wxrksProjectUUID).toLowerCase().includes(historySearchTerm)) return false;
    return true;
  });

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
      <>
      {/* History */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="max-w-[320px] flex-1">
          <input
            type="text"
            value={historySearch}
            onChange={(e) => setHistorySearch(e.target.value)}
            placeholder="Search runs…"
            className="w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink outline-none focus:border-accent"
          />
        </div>
        <div className="flex gap-2">
          {[
            ["all", "All"],
            ["synced", "Synced"],
            ["issues", "Issues"],
          ].map(([value, label]) => (
            <button
              key={value}
              onClick={() => setHistoryStatusFilter(value)}
              className={
                "rounded-full border px-3 py-1 text-xs font-semibold " +
                (historyStatusFilter === value ? "border-ink bg-ink text-canvas" : "border-border-strong bg-surface text-ink-soft")
              }
            >
              {label} <span className="ml-1 tabular-nums opacity-70">{historyStatusCounts[value]}</span>
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {[
            ["all", "All modes"],
            ["one-time", "One-time"],
            ["recurring", "Recurring"],
          ].map(([value, label]) => (
            <button
              key={value}
              onClick={() => setLogType(value)}
              className={
                "rounded-full border px-3 py-1 text-xs font-semibold " +
                (logType === value ? "border-ink bg-ink text-canvas" : "border-border-strong bg-surface text-ink-soft")
              }
            >
              {label}
            </button>
          ))}
        </div>
        <span className="ml-auto whitespace-nowrap text-xs text-ink-faint">
          {filteredHistory.length} of {(history || []).length} runs
        </span>
      </div>

      {history === null ? (
        <p className="text-sm text-ink-soft">Loading history...</p>
      ) : filteredHistory.length === 0 ? (
        <Card className="p-6 text-center text-sm text-ink-faint">
          {historySearchTerm ? `No runs match "${historySearch.trim()}"` : "No runs of this type yet."}
        </Card>
      ) : (
        <>
        <div className="mb-1.5 hidden items-center gap-3 px-4 text-[10.5px] font-bold uppercase tracking-wide text-ink-faint sm:flex">
          <span className="w-3 flex-none" />
          <span className="min-w-0 flex-1">Project</span>
          <span className="w-12 flex-none text-right">Docs</span>
          <span className="w-16 flex-none text-right">Words</span>
          <span className="w-24 flex-none">Langs</span>
          <span className="w-[104px] flex-none">Sent to wxrks</span>
          <span className="w-[104px] flex-none">Updated on Webflow</span>
          <span className="w-24 flex-none text-right">Status</span>
        </div>
        <div className="flex flex-col gap-2">
          {filteredHistory.map(({ batch, status }) => {
            const isOpen = Boolean(expandedRuns[batch.wxrksProjectUUID]);
            const workUnits = workUnitsByRun[batch.wxrksProjectUUID];
            const documents = Array.isArray(workUnits) ? groupWorkUnitsByDocument(workUnits, batch) : null;
            const wordCount = batch.items.reduce((sum, i) => sum + (i.wordCount || 0), 0);
            return (
              <Card id={batch.wxrksProjectUUID} key={batch.wxrksProjectUUID}>
                <div
                  onClick={() => toggleRunWorkUnits(batch.wxrksProjectUUID)}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 cursor-pointer hover:bg-surface-sunken"
                >
                  <span className={"w-3 flex-none text-[10px] text-ink-faint transition-transform " + (isOpen ? "rotate-90" : "")}>▸</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {batch.reference ? (
                        <span className="truncate text-[13.5px] font-semibold text-ink">{batch.reference}</span>
                      ) : (
                        <span className="truncate font-mono text-[12px] text-ink-faint">{batch.wxrksProjectUUID}</span>
                      )}
                      <span
                        className={
                          "rounded-full px-2 py-0.5 text-[10.5px] font-semibold " +
                          (batch.mode === "automation" ? "bg-status-auto-bg text-status-auto-fg" : "bg-accent-subtle text-accent-text")
                        }
                      >
                        {batch.mode === "automation" ? "Recurring" : "One-time"}
                      </span>
                      <a
                        href={wxrksProjectUrl(batch.wxrksProjectUUID)}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className={linkClass + " whitespace-nowrap text-xs"}
                      >
                        Open in wxrks →
                      </a>
                    </div>
                  </div>
                  <span className="w-12 flex-none text-right font-mono text-[12.5px] tabular-nums text-ink-soft">{batch.items.length}</span>
                  <span className="w-16 flex-none text-right font-mono text-[12.5px] tabular-nums text-ink-soft">{wordCount.toLocaleString()}</span>
                  <span className="flex w-24 flex-none flex-wrap gap-1">
                    {langChips(batch.targetLocales).map((l) => (
                      <Chip key={l}>{l}</Chip>
                    ))}
                  </span>
                  <span className="w-[104px] flex-none text-[12px] text-ink-soft">{formatDateTime(batch.createdAt, timezone)}</span>
                  <span className="w-[104px] flex-none text-[12px] text-ink-soft">
                    {status.latestDeliveredAt ? formatDateTime(status.latestDeliveredAt, timezone) : "—"}
                  </span>
                  <span className="w-24 flex-none text-right">
                    {status.hasErrors ? (
                      <StatusPill variant="error" label="Issues" />
                    ) : status.complete ? (
                      <StatusPill variant="success" label="Synced" />
                    ) : (
                      <StatusPill variant="progress" label="In progress" />
                    )}
                  </span>
                </div>

                {isOpen && (
                  <div className="border-t border-border bg-surface-sunken px-4 py-3">
                    <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-[12.5px] text-ink-soft">
                      {batch.contentScope && (
                        <span>
                          Sync criteria:{" "}
                          <strong className="font-semibold text-ink">{scopeSummary(batch.contentScope, collections, pageFolders)}</strong>
                        </span>
                      )}
                      <span className="ml-auto">
                        Time to translate: <strong className="font-semibold text-ink">{formatDuration(batch.createdAt, status)}</strong>
                      </span>
                    </div>

                    {status.hasErrors && (
                      <div className="mb-3 rounded-md border border-status-error-bg bg-status-error-bg p-3">
                        <div className="flex flex-col gap-1.5">
                          {status.errors.map((e, i) => (
                            <div key={i} className="flex items-start gap-2 text-xs">
                              <span className="text-status-error-fg">⚠</span>
                              <div>
                                <span className="text-ink-soft">
                                  {e.entityId} ({e.locale})
                                </span>
                                <div className="mt-0.5 rounded bg-surface px-2 py-1 font-mono text-[11.5px] text-status-error-fg">{e.error}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {workUnits === "loading" || workUnits === undefined ? (
                      <p className="text-sm text-ink-faint">Loading documents...</p>
                    ) : workUnits === "error" ? (
                      <p className="text-sm text-status-error-fg">Couldn't load documents for this run.</p>
                    ) : documents.length === 0 ? (
                      <p className="text-sm text-ink-faint">No documents in this run.</p>
                    ) : (
                      <div className="overflow-x-auto rounded-md border border-border bg-surface">
                        <table className="w-full text-left text-[12.5px]">
                          <thead>
                            <tr className="border-b border-border bg-surface-sunken text-[10.5px] font-bold uppercase tracking-wide text-ink-faint">
                              <th className="px-3 py-2">Document</th>
                              <th className="px-3 py-2 text-right">Words</th>
                              <th className="px-3 py-2">Languages</th>
                              <th className="px-3 py-2">Sent to wxrks</th>
                              <th className="px-3 py-2">Updated on Webflow</th>
                              <th className="px-3 py-2">Status</th>
                              <th className="px-3 py-2" />
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {documents.map((doc) => (
                              <tr key={doc.entityId}>
                                <td className="px-3 py-2 font-mono text-ink">{doc.workUnitName}</td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-ink-soft">{doc.words.toLocaleString()}</td>
                                <td className="px-3 py-2 text-ink-soft">{doc.locales.join(", ")}</td>
                                <td className="px-3 py-2 text-ink-soft">{formatDateTime(batch.createdAt, timezone)}</td>
                                <td className="px-3 py-2 text-ink-soft">
                                  {doc.latestUpdatedAt ? formatDateTime(doc.latestUpdatedAt, timezone) : <span className="text-ink-faint">—</span>}
                                </td>
                                <td className="px-3 py-2">
                                  {doc.hasError ? (
                                    <StatusPill variant="error" label="Error" />
                                  ) : doc.allDelivered ? (
                                    <StatusPill variant="success" label="Synced" />
                                  ) : (
                                    <StatusPill variant="progress" label="Pending" />
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right">
                                  {doc.link ? (
                                    <a href={doc.link.url} target="_blank" rel="noreferrer" className={linkClass}>
                                      {doc.link.type === "published" ? "View live →" : "Open in Designer →"}
                                    </a>
                                  ) : (
                                    <span className="text-ink-faint">—</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
        </>
      )}
      </>
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
