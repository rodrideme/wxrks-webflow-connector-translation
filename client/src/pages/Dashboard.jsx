import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api.js";
import { wxrksProjectUrl } from "../wxrksLinks.js";

const cardClass = "mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm";
const linkClass = "font-medium text-brand-600 hover:text-brand-700 hover:underline";

export default function Dashboard() {
  const [backlog, setBacklog] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [orgUnits, setOrgUnits] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getBacklog(),
      api.getSyncStatus(),
      api.getOrgUnits().catch(() => ({ orgUnits: [] })),
    ])
      .then(([backlogRes, statusRes, orgUnitsRes]) => {
        setBacklog(backlogRes);
        setSyncStatus(statusRes);
        setOrgUnits(orgUnitsRes.orgUnits || []);
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

  if (loading) return <p className="text-slate-600">Loading dashboard...</p>;
  if (error) return <p className="text-sm font-medium text-red-600">Error: {error}</p>;

  const lastSync = syncStatus?.lastSync;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-slate-900">Dashboard</h1>

      <section className={cardClass}>
        <h2 className="mb-3 text-base font-semibold text-slate-900">Backlog by collection</h2>
        {Object.keys(backlogByCollection).length === 0 ? (
          <p className="text-sm text-slate-600">No untranslated items. Backlog is clear.</p>
        ) : (
          <ul className="space-y-1 text-sm text-slate-700">
            {Object.entries(backlogByCollection).map(([name, count]) => (
              <li key={name}>
                {name}: <strong>{count}</strong> pending
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-sm font-medium text-slate-500">Total backlog: {backlog?.count ?? 0}</p>
      </section>

      <section className={cardClass}>
        <h2 className="mb-3 text-base font-semibold text-slate-900">Last sync</h2>
        {lastSync ? (
          <>
            <p className="text-sm text-slate-700">
              {lastSync.mode} sync at {new Date(lastSync.timestamp).toLocaleString()}
            </p>
            {lastSync.summary && (
              <ul className="mt-2 space-y-1 text-sm text-slate-700">
                <li>
                  Items: {lastSync.summary.itemsSynced ?? lastSync.summary.itemsProcessed ?? 0} synced,{" "}
                  {lastSync.summary.skipped ?? 0} skipped, {lastSync.summary.errors ?? 0} error(s)
                </li>
                {lastSync.summary.estimatedWordCount !== undefined && (
                  <li>Estimated words: {lastSync.summary.estimatedWordCount.toLocaleString()}</li>
                )}
                {lastSync.summary.orgUnitUUID && <li>Org unit: {orgUnitName(lastSync.summary.orgUnitUUID)}</li>}
                {lastSync.summary.targetLocales && (
                  <li>Target locales: {lastSync.summary.targetLocales.join(", ")}</li>
                )}
                {lastSync.summary.wxrksProjectUUID && (
                  <li>
                    <a href={wxrksProjectUrl(lastSync.summary.wxrksProjectUUID)} target="_blank" rel="noreferrer" className={linkClass}>
                      Open in wxrks
                    </a>{" "}
                    ·{" "}
                    <Link to={`/history#${lastSync.summary.wxrksProjectUUID}`} className={linkClass}>
                      View in History
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </>
        ) : (
          <p className="text-sm text-slate-600">No syncs run yet.</p>
        )}
      </section>

      <section className={cardClass}>
        <h2 className="mb-3 text-base font-semibold text-slate-900">Active wxrks projects</h2>
        {(syncStatus?.activeProjects || []).length === 0 ? (
          <p className="text-sm text-slate-600">No translations in progress.</p>
        ) : (
          <ul className="space-y-3 text-sm text-slate-700">
            {syncStatus.activeProjects.map((p) => (
              <li key={p.wxrksProjectUUID} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="font-mono text-xs text-slate-500">{p.wxrksProjectUUID}</div>
                <div className="mt-1">
                  {p.mode} batch, {p.items.length} item(s) across {p.collectionIds.length} collection(s) →{" "}
                  {p.targetLocales.join(", ")}{" "}
                  <span className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700">
                    {p.wxrksStatus}
                  </span>
                </div>
                <div className="mt-1.5">
                  <a href={wxrksProjectUrl(p.wxrksProjectUUID)} target="_blank" rel="noreferrer" className={linkClass}>
                    Open in wxrks
                  </a>{" "}
                  ·{" "}
                  <Link to={`/history#${p.wxrksProjectUUID}`} className={linkClass}>
                    View in History
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
