import { useEffect, useState } from "react";
import api from "../services/api.js";
import { wxrksProjectUrl } from "../wxrksLinks.js";
import { formatDateTime } from "../formatDate.js";
import Card from "../components/Card.jsx";
import StatusPill from "../components/StatusPill.jsx";
import Chip from "../components/Chip.jsx";

const linkClass = "font-medium text-accent-text hover:underline";

function modeLabel(mode) {
  if (mode === "pages-bulk") return "Pages · Bulk Sync";
  if (mode === "pages-item") return "Pages · Item Sync";
  if (mode === "components-bulk") return "Components · Bulk Sync";
  if (mode === "components-item") return "Components · Item Sync";
  if (mode === "bulk") return "Bulk Sync";
  if (mode === "item") return "Item Sync";
  if (mode === "auto") return "Auto Sync";
  return mode;
}

export default function History() {
  const [history, setHistory] = useState(null);
  const [collections, setCollections] = useState([]);
  const [pages, setPages] = useState([]);
  const [components, setComponents] = useState([]);
  const [orgUnits, setOrgUnits] = useState([]);
  const [timezone, setTimezone] = useState(undefined);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      api.getSyncHistory(),
      api.getCollections().catch(() => ({ collections: [] })),
      api.getPages().catch(() => ({ pages: [] })),
      api.getComponents().catch(() => ({ components: [] })),
      api.getOrgUnits().catch(() => ({ orgUnits: [] })),
      api.getSettings().catch(() => null),
    ])
      .then(([historyRes, collectionsRes, pagesRes, componentsRes, orgUnitsRes, settingsRes]) => {
        setHistory(historyRes.history || []);
        setCollections(collectionsRes.collections || []);
        setPages(pagesRes.pages || []);
        setComponents(componentsRes.components || []);
        setOrgUnits(orgUnitsRes.orgUnits || []);
        setTimezone(settingsRes?.timezone);
      })
      .catch((err) => setError(err.message));
  }, []);

  // Deep-link support: /history#<wxrksProjectUUID> scrolls straight to that
  // batch's card (used by the Dashboard's active-projects list).
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

  if (error) return <p className="text-sm font-medium text-status-error-fg">Error: {error}</p>;
  if (!history) return <p className="text-sm text-ink-soft">Loading history...</p>;

  return (
    <div>
      <h1 className="mb-6 text-[22px] font-semibold tracking-tight text-ink">History</h1>
      {history.length === 0 && <p className="text-sm text-ink-soft">No sync batches yet.</p>}

      <div className="flex flex-col gap-5">
        {history.map((batch) => {
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
                <StatusPill variant={batch.status === "completed" ? "success" : "progress"} label={batch.status} />
              </div>

              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Sent to wxrks</p>
              <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-md border border-border bg-surface-sunken p-3.5 text-[13px] sm:grid-cols-3">
                <Field label="Created" value={formatDateTime(batch.createdAt, timezone)} />
                <Field label="Mode" value={modeLabel(batch.mode)} />
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
                                  <div className="mt-0.5 rounded bg-status-error-bg px-2 py-1 font-mono text-[11.5px] text-status-error-fg">
                                    {e.message}
                                  </div>
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
