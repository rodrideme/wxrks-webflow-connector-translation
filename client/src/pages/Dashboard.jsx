import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api.js";
import { wxrksProjectUrl } from "../wxrksLinks.js";

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

  if (loading) return <p>Loading dashboard...</p>;
  if (error) return <p className="error">Error: {error}</p>;

  const lastSync = syncStatus?.lastSync;

  return (
    <div>
      <h1>Dashboard</h1>

      <section className="card">
        <h2>Backlog by collection</h2>
        {Object.keys(backlogByCollection).length === 0 ? (
          <p>No untranslated items. Backlog is clear.</p>
        ) : (
          <ul>
            {Object.entries(backlogByCollection).map(([name, count]) => (
              <li key={name}>
                {name}: <strong>{count}</strong> pending
              </li>
            ))}
          </ul>
        )}
        <p>Total backlog: {backlog?.count ?? 0}</p>
      </section>

      <section className="card">
        <h2>Last sync</h2>
        {lastSync ? (
          <>
            <p>
              {lastSync.mode} sync at {new Date(lastSync.timestamp).toLocaleString()}
            </p>
            {lastSync.summary && (
              <ul>
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
                    <a href={wxrksProjectUrl(lastSync.summary.wxrksProjectUUID)} target="_blank" rel="noreferrer">
                      Open in wxrks
                    </a>{" "}
                    · <Link to={`/history#${lastSync.summary.wxrksProjectUUID}`}>View in History</Link>
                  </li>
                )}
              </ul>
            )}
          </>
        ) : (
          <p>No syncs run yet.</p>
        )}
      </section>

      <section className="card">
        <h2>Active wxrks projects</h2>
        {(syncStatus?.activeProjects || []).length === 0 ? (
          <p>No translations in progress.</p>
        ) : (
          <ul>
            {syncStatus.activeProjects.map((p) => (
              <li key={p.wxrksProjectUUID}>
                {p.wxrksProjectUUID} — {p.mode} batch, {p.items.length} item(s) across{" "}
                {p.collectionIds.length} collection(s) → {p.targetLocales.join(", ")} ({p.wxrksStatus}) —{" "}
                <a href={wxrksProjectUrl(p.wxrksProjectUUID)} target="_blank" rel="noreferrer">
                  Open in wxrks
                </a>{" "}
                · <Link to={`/history#${p.wxrksProjectUUID}`}>View in History</Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
