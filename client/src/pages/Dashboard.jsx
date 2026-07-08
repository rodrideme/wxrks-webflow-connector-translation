import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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

function projectErrorCount(p) {
  return (p.updates || []).reduce(
    (sum, u) =>
      sum + (u.resultsByItem || []).reduce((s, r) => s + (r.resultsByLocale || []).filter((rl) => rl.error).length, 0),
    0
  );
}

function projectWordsDelivered(p) {
  return (p.updates || []).reduce((sum, u) => sum + (u.wordCount || 0), 0);
}

function projectTotalWords(p) {
  return (p.items || []).reduce((sum, i) => sum + (i.wordCount || 0), 0);
}

export default function Dashboard() {
  const [backlog, setBacklog] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [orgUnits, setOrgUnits] = useState([]);
  const [timezone, setTimezone] = useState(undefined);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getBacklog(),
      api.getSyncStatus(),
      api.getOrgUnits().catch(() => ({ orgUnits: [] })),
      api.getSettings().catch(() => null),
    ])
      .then(([backlogRes, statusRes, orgUnitsRes, settingsRes]) => {
        setBacklog(backlogRes);
        setSyncStatus(statusRes);
        setOrgUnits(orgUnitsRes.orgUnits || []);
        setTimezone(settingsRes?.timezone);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function orgUnitName(uuid) {
    const o = orgUnits.find((o) => o.uuid === uuid);
    return o ? o.name : uuid;
  }

  const backlogByCollection = (backlog?.backlog || []).reduce((acc, entry) => {
    acc[entry.collectionName] = (acc[entry.collectionName] || 0) + 1;
    return acc;
  }, {});
  const backlogEntries = Object.entries(backlogByCollection);
  const maxBacklogCount = Math.max(1, ...backlogEntries.map(([, count]) => count));

  if (loading) return <p className="text-sm text-ink-soft">Loading dashboard...</p>;
  if (error) return <p className="text-sm font-medium text-status-error-fg">Error: {error}</p>;

  const lastSync = syncStatus?.lastSync;
  const lastSyncFailed = (lastSync?.summary?.errors ?? 0) > 0;

  return (
    <div>
      <h1 className="mb-6 text-[22px] font-semibold tracking-tight text-ink">Dashboard</h1>

      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Backlog by collection</p>
      {backlogEntries.length === 0 ? (
        <Card className="mb-6 px-4 py-4 text-sm text-ink-soft">No untranslated items. Backlog is clear.</Card>
      ) : (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {backlogEntries.map(([name, count]) => (
            <Card key={name} className="p-3.5">
              <div className="mb-2 text-[12.5px] font-semibold text-ink-soft">{name}</div>
              <div className="text-xl font-semibold text-ink">
                {count} <small className="text-xs font-medium text-ink-faint">items pending</small>
              </div>
              <div className="mt-2 h-[5px] overflow-hidden rounded-full bg-surface-sunken">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${Math.max(6, Math.round((count / maxBacklogCount) * 100))}%` }}
                />
              </div>
            </Card>
          ))}
        </div>
      )}
      <p className="mb-6 -mt-3 text-xs text-ink-faint">Total backlog: {backlog?.count ?? 0}</p>

      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Last sync result</p>
      <Card className="mb-6 flex items-center gap-4 p-4">
        {lastSync ? (
          <>
            <div
              className={
                "flex h-9 w-9 flex-none items-center justify-center rounded-lg text-base " +
                (lastSyncFailed ? "bg-status-error-bg text-status-error-fg" : "bg-status-success-bg text-status-success-fg")
              }
            >
              {lastSyncFailed ? "!" : "✓"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-ink">
                {modeLabel(lastSync.mode)} {lastSyncFailed ? "finished with errors" : "completed"}
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">
                <span className="font-mono tabular-nums">
                  {lastSync.summary?.itemsSynced ?? lastSync.summary?.itemsProcessed ?? 0} synced
                </span>
                {lastSync.summary?.skipped ? (
                  <>
                    {" · "}
                    <span className="font-mono tabular-nums">{lastSync.summary.skipped} skipped</span>
                  </>
                ) : null}
                {lastSync.summary?.estimatedWordCount !== undefined && (
                  <>
                    {" · "}
                    <span className="font-mono tabular-nums">
                      {lastSync.summary.estimatedWordCount.toLocaleString()} words
                    </span>
                  </>
                )}
                {" · "}
                {formatDateTime(lastSync.timestamp, timezone)}
                {lastSync.summary?.errors ? (
                  <>
                    {" · "}
                    <span className="font-medium text-status-error-fg">{lastSync.summary.errors} error(s)</span>
                  </>
                ) : (
                  " · 0 errors"
                )}
              </div>
            </div>
            {lastSync.summary?.wxrksProjectUUID && (
              <Link to={`/logs#${lastSync.summary.wxrksProjectUUID}`} className={linkClass + " flex-none text-[13px]"}>
                View in Logs →
              </Link>
            )}
          </>
        ) : (
          <p className="text-sm text-ink-soft">No syncs run yet.</p>
        )}
      </Card>

      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Active wxrks projects</p>
      </div>
      <Card>
        {(syncStatus?.activeProjects || []).length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">No translations in progress.</p>
        ) : (
          syncStatus.activeProjects.map((p) => {
            const errCount = projectErrorCount(p);
            const delivered = projectWordsDelivered(p);
            const total = projectTotalWords(p);
            return (
              <div
                key={p.wxrksProjectUUID}
                className="flex flex-wrap items-center gap-3.5 border-t border-border px-4 py-3.5 first:border-t-0"
              >
                <div className="min-w-[10rem] flex-1">
                  <div className="text-[13.5px] font-semibold text-ink">{modeLabel(p.mode)}</div>
                  <div className="mt-0.5 font-mono text-[11.5px] text-ink-faint">{p.wxrksProjectUUID}</div>
                </div>
                {errCount > 0 ? (
                  <StatusPill variant="error" label={`${errCount} error${errCount === 1 ? "" : "s"}`} />
                ) : (
                  <StatusPill variant="progress" />
                )}
                <div className="text-[12.5px] text-ink-soft">
                  <span className="font-mono font-semibold tabular-nums text-ink">{delivered.toLocaleString()}</span> /{" "}
                  <span className="font-mono tabular-nums">{total.toLocaleString()}</span> words
                </div>
                <div className="flex flex-wrap gap-1">
                  {p.targetLocales.map((l) => (
                    <Chip key={l}>{l}</Chip>
                  ))}
                </div>
                <div className="ml-auto flex gap-3 whitespace-nowrap text-xs">
                  <a href={wxrksProjectUrl(p.wxrksProjectUUID)} target="_blank" rel="noreferrer" className={linkClass}>
                    wxrks ↗
                  </a>
                  <Link to={`/logs#${p.wxrksProjectUUID}`} className={linkClass}>
                    Logs
                  </Link>
                </div>
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}
