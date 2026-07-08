import { useEffect, useState } from "react";
import api from "../services/api.js";
import { wxrksProjectUrl } from "../wxrksLinks.js";
import { formatDateTime } from "../formatDate.js";
import Card from "../components/Card.jsx";
import StatusPill from "../components/StatusPill.jsx";
import Chip from "../components/Chip.jsx";

const linkClass = "font-medium text-accent-text hover:underline";

function modeLabel(mode, automationName) {
  if (mode === "pages-bulk") return "Pages · Bulk Sync";
  if (mode === "pages-item") return "Pages · Item Sync";
  if (mode === "components-bulk") return "Components · Bulk Sync";
  if (mode === "components-item") return "Components · Item Sync";
  if (mode === "bulk") return "Bulk Sync";
  if (mode === "item") return "Item Sync";
  if (mode === "auto") return "Auto Sync";
  if (mode === "automation") return automationName ? `Automation · ${automationName}` : "Automation";
  return mode;
}

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

function cadenceLabel(cadence) {
  if (!cadence) return "—";
  if (cadence.kind === "hourly") return `Hourly · every ${cadence.everyHours}h from ${cadence.startTime}`;
  if (cadence.kind === "weekly") return `Weekly · ${cadence.weekday} ${cadence.time}`;
  return `Daily · ${cadence.time}`;
}

function webhookPill(status) {
  if (status === "active") return <StatusPill variant="success" label="Webhook healthy" />;
  if (status === "not_registered") return <StatusPill variant="draft" label="Webhook not registered" />;
  return <StatusPill variant="error" label={`Webhook ${status.replace("_", " ")}`} />;
}

export default function Runs() {
  const [automations, setAutomations] = useState(null);
  const [pendingItems, setPendingItems] = useState([]);
  const [webhook, setWebhook] = useState(null);
  const [history, setHistory] = useState(null);
  const [collections, setCollections] = useState([]);
  const [pages, setPages] = useState([]);
  const [pageFolders, setPageFolders] = useState([]);
  const [components, setComponents] = useState([]);
  const [orgUnits, setOrgUnits] = useState([]);
  const [timezone, setTimezone] = useState(undefined);
  const [logType, setLogType] = useState("all"); // all | one-time | recurring
  const [detailAutomation, setDetailAutomation] = useState(null);
  const [flushing, setFlushing] = useState(false);
  const [error, setError] = useState(null);

  function loadAutomations() {
    api
      .listAutomations()
      .then((res) => {
        setAutomations(res.automations || []);
        setPendingItems(res.pendingItems || []);
        setWebhook(res.webhook);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    loadAutomations();
    Promise.all([
      api.getSyncHistory(),
      api.getCollections().catch(() => ({ collections: [] })),
      api.getPages().catch(() => ({ pages: [] })),
      api.getPageFolders().catch(() => ({ folders: [] })),
      api.getComponents().catch(() => ({ components: [] })),
      api.getOrgUnits().catch(() => ({ orgUnits: [] })),
      api.getSettings().catch(() => null),
    ])
      .then(([historyRes, collectionsRes, pagesRes, foldersRes, componentsRes, orgUnitsRes, settingsRes]) => {
        setHistory(historyRes.history || []);
        setCollections(collectionsRes.collections || []);
        setPages(pagesRes.pages || []);
        setPageFolders(foldersRes.folders || []);
        setComponents(componentsRes.components || []);
        setOrgUnits(orgUnitsRes.orgUnits || []);
        setTimezone(settingsRes?.timezone);
      })
      .catch((err) => setError(err.message));
  }, []);

  // Deep-link support: /logs#<wxrksProjectUUID> scrolls straight to that
  // batch's card (used by the Dashboard's active-projects list). Route
  // itself now redirects to /runs, so the hash still lands here.
  useEffect(() => {
    if (!history || !window.location.hash) return;
    const el = document.getElementById(window.location.hash.slice(1));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [history]);

  function collectionName(id) {
    const c = collections.find((c) => c.id === id);
    return c ? c.displayName || c.singularName : id;
  }
  function pageName(id) {
    const p = pages.find((p) => p.id === id);
    return p ? p.title || p.slug : id;
  }
  function componentName(id) {
    const c = components.find((c) => c.id === id);
    return c ? c.name : id;
  }
  function orgUnitName(uuid) {
    const o = orgUnits.find((o) => o.uuid === uuid);
    return o ? o.name : uuid;
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

  const filteredHistory = (history || []).filter((batch) => {
    if (logType === "all") return true;
    const type = batch.mode === "automation" ? "recurring" : "one-time";
    return type === logType;
  });

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Runs</h1>
        <p className="mt-0.5 text-[13px] text-ink-faint">Recurring automations, their pending queue, and every past translation run.</p>
      </div>

      {error && <p className="mb-4 text-sm font-medium text-status-error-fg">Error: {error}</p>}

      {/* Recurring automations */}
      <Card className="mb-4">
        <div className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
          <span className="text-[13px] font-semibold text-ink">Recurring automations</span>
          <span className="text-[11.5px] text-ink-faint">Created from Translate → Send</span>
        </div>
        {automations === null ? (
          <p className="p-4 text-sm text-ink-faint">Loading…</p>
        ) : automations.length === 0 ? (
          <p className="p-4 text-sm text-ink-faint">No automations yet — create one from Translate → Send.</p>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[46rem]">
              {automations.map((a) => (
                <div
                  key={a.id}
                  onClick={() => setDetailAutomation(a)}
                  className="grid cursor-pointer grid-cols-[1fr_140px_100px_auto] items-center gap-4 border-t border-border px-4 py-3 first:border-t-0 hover:bg-surface-sunken"
                  style={{ opacity: a.archived ? 0.55 : 1 }}
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-medium text-ink">{a.name}</div>
                    <div className="truncate font-mono text-[11px] text-ink-faint">{scopeSummary(a.contentScope, collections, pageFolders)}</div>
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
                      <button onClick={() => togglePause(a)} className="rounded-md border border-border-strong bg-surface px-2.5 py-1 text-xs font-semibold hover:border-ink-faint">
                        {a.enabled ? "Pause" : "Resume"}
                      </button>
                    )}
                    <button onClick={() => toggleArchive(a)} className="rounded-md border border-border-strong bg-surface px-2.5 py-1 text-xs font-semibold hover:border-ink-faint">
                      {a.archived ? "Unarchive" : "Archive"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {webhook && <div className="mb-6 flex items-center gap-2">{webhookPill(webhook.status)}</div>}

      {/* Pending queue */}
      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-status-auto-dot" />
            Pending queue
          </span>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] text-ink-faint">
              {pendingItems.length} items · {pendingItems.reduce((s, p) => s + (p.wordCount || 0), 0).toLocaleString()} words
            </span>
            <button
              onClick={flushAll}
              disabled={flushing || pendingItems.length === 0}
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
                <div className="text-[11px] text-ink-faint">{p.collectionName || p.entityType}</div>
              </div>
              <span className="rounded-full bg-status-auto-bg px-2.5 py-0.5 text-[11px] font-semibold text-status-auto-fg">{p.trigger}</span>
              <span className="font-mono text-[11.5px] text-ink-faint">{formatDateTime(p.enqueuedAt, timezone)}</span>
            </div>
          ))
        )}
      </Card>

      {/* History */}
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="text-[14px] font-semibold text-ink">History</span>
        <div className="flex gap-2">
          {[
            ["all", "All"],
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
      </div>

      {history === null ? (
        <p className="text-sm text-ink-soft">Loading history...</p>
      ) : filteredHistory.length === 0 ? (
        <Card className="p-6 text-center text-sm text-ink-faint">No runs of this type yet.</Card>
      ) : (
        <div className="flex flex-col gap-5">
          {filteredHistory.map((batch) => {
            const wordCount = batch.items.reduce((sum, i) => sum + (i.wordCount || 0), 0);
            return (
              <Card className="p-5" id={batch.wxrksProjectUUID} key={batch.wxrksProjectUUID}>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="break-all font-mono text-[13px] font-semibold text-ink">{batch.wxrksProjectUUID}</h2>
                    <a href={wxrksProjectUrl(batch.wxrksProjectUUID)} target="_blank" rel="noreferrer" className={linkClass + " text-xs"}>
                      Open in wxrks →
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={"rounded-full px-2.5 py-0.5 text-[11px] font-semibold " + (batch.mode === "automation" ? "bg-status-auto-bg text-status-auto-fg" : "bg-accent-subtle text-accent-text")}>
                      {batch.mode === "automation" ? "Recurring" : "One-time"}
                    </span>
                    <StatusPill variant={batch.status === "completed" ? "success" : "progress"} label={batch.status} />
                  </div>
                </div>

                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Sent to wxrks</p>
                <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-md border border-border bg-surface-sunken p-3.5 text-[13px] sm:grid-cols-3">
                  <Field label="Created" value={formatDateTime(batch.createdAt, timezone)} />
                  <Field label="Mode" value={modeLabel(batch.mode, batch.automationName)} />
                  <Field label="wxrks status" value={batch.wxrksStatus} />
                  <Field label="Org unit" value={batch.orgUnitUUID ? orgUnitName(batch.orgUnitUUID) : "—"} />
                  <Field label="Source" value={batch.sourceLocale} mono />
                  <Field
                    label="Targets"
                    value={
                      <span className="flex flex-wrap gap-1">
                        {batch.targetLocales.map((l) => (
                          <Chip key={l}>{l}</Chip>
                        ))}
                      </span>
                    }
                  />
                  <Field
                    label={batch.mode?.startsWith("pages-") ? "Pages" : batch.mode?.startsWith("components-") ? "Components" : "Collections"}
                    value={
                      batch.mode?.startsWith("pages-")
                        ? batch.items.map((i) => pageName(i.webflowPageId)).join(", ") || "—"
                        : batch.mode?.startsWith("components-")
                        ? batch.items.map((i) => componentName(i.webflowComponentId)).join(", ") || "—"
                        : batch.collectionIds.map(collectionName).join(", ") || "—"
                    }
                  />
                  <Field label="Items" value={<span className="font-mono tabular-nums">{batch.items.length}</span>} />
                  <Field label="Words" value={<span className="font-mono tabular-nums">{wordCount.toLocaleString()}</span>} />
                  <Field label="Naming pattern" value={batch.workUnitNamePattern || "—"} mono />
                </div>

                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Updated on Webflow</p>
                {batch.updates.length === 0 ? (
                  <p className="text-sm text-ink-faint">No translations pushed back to Webflow yet.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {batch.updates.map((update, i) => {
                      const errors = (update.resultsByItem || []).flatMap((item) =>
                        (item.resultsByLocale || [])
                          .filter((l) => l.error)
                          .map((l) => ({
                            id: item.webflowComponentId || item.webflowPageId || item.webflowItemId,
                            locale: l.locale,
                            message: l.error,
                          }))
                      );
                      return (
                        <div key={i} className="rounded-md border border-border bg-surface-sunken p-3">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-soft">
                            {errors.length > 0 ? (
                              <StatusPill variant="error" label={`${errors.length} error${errors.length === 1 ? "" : "s"}`} />
                            ) : (
                              <StatusPill variant="success" label="Pushed" />
                            )}
                            <span>{formatDateTime(update.updatedAt, timezone)}</span>
                            <span>{update.targetLocales.join(", ")}</span>
                            <span>
                              <span className="font-mono tabular-nums text-ink">{update.itemsUpdated}</span> item(s) ·{" "}
                              <span className="font-mono tabular-nums text-ink">{update.wordCount.toLocaleString()}</span> words
                            </span>
                            <span>{update.autoPublish ? "Published" : "Left as Draft"}</span>
                          </div>
                          {errors.length > 0 && (
                            <div className="mt-2 flex flex-col gap-1.5">
                              {errors.map((e, j) => (
                                <div key={j} className="flex items-start gap-2 text-xs">
                                  <span className="text-status-error-fg">⚠</span>
                                  <div>
                                    <span className="text-ink-soft">
                                      {e.id} ({e.locale})
                                    </span>
                                    <div className="mt-0.5 rounded bg-status-error-bg px-2 py-1 font-mono text-[11.5px] text-status-error-fg">{e.message}</div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {detailAutomation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-6" onClick={() => setDetailAutomation(null)}>
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

function Field({ label, value, mono = false }) {
  return (
    <div>
      <div className="text-ink-faint">{label}</div>
      <div className={"font-medium text-ink " + (mono ? "font-mono text-xs" : "")}>{value}</div>
    </div>
  );
}
