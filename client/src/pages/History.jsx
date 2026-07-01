import { useEffect, useState } from "react";
import api from "../services/api.js";
import { wxrksProjectUrl } from "../wxrksLinks.js";

export default function History() {
  const [history, setHistory] = useState(null);
  const [collections, setCollections] = useState([]);
  const [orgUnits, setOrgUnits] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      api.getSyncHistory(),
      api.getCollections().catch(() => ({ collections: [] })),
      api.getOrgUnits().catch(() => ({ orgUnits: [] })),
    ])
      .then(([historyRes, collectionsRes, orgUnitsRes]) => {
        setHistory(historyRes.history || []);
        setCollections(collectionsRes.collections || []);
        setOrgUnits(orgUnitsRes.orgUnits || []);
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

  function orgUnitName(uuid) {
    const o = orgUnits.find((o) => o.uuid === uuid);
    return o ? o.name : uuid;
  }

  if (error) return <p className="error">Error: {error}</p>;
  if (!history) return <p>Loading history...</p>;

  return (
    <div>
      <h1>History</h1>
      {history.length === 0 && <p>No sync batches yet.</p>}

      {history.map((batch) => {
        const wordCount = batch.items.reduce((sum, i) => sum + (i.wordCount || 0), 0);
        return (
          <section className="card" id={batch.wxrksProjectUUID} key={batch.wxrksProjectUUID}>
            <h2>{batch.wxrksProjectUUID}</h2>
            <p>
              <a href={wxrksProjectUrl(batch.wxrksProjectUUID)} target="_blank" rel="noreferrer">
                Open in wxrks
              </a>
            </p>

            <h3>Sent to wxrks</h3>
            <table className="kv-table">
              <tbody>
                <tr>
                  <td>Created</td>
                  <td>{new Date(batch.createdAt).toLocaleString()}</td>
                </tr>
                <tr>
                  <td>Mode</td>
                  <td>{batch.mode}</td>
                </tr>
                <tr>
                  <td>Status</td>
                  <td>
                    {batch.status} ({batch.wxrksStatus})
                  </td>
                </tr>
                <tr>
                  <td>Org unit</td>
                  <td>{batch.orgUnitUUID ? orgUnitName(batch.orgUnitUUID) : "—"}</td>
                </tr>
                <tr>
                  <td>Source locale</td>
                  <td>{batch.sourceLocale}</td>
                </tr>
                <tr>
                  <td>Target locales</td>
                  <td>{batch.targetLocales.join(", ")}</td>
                </tr>
                <tr>
                  <td>Collections</td>
                  <td>{batch.collectionIds.map(collectionName).join(", ") || "—"}</td>
                </tr>
                <tr>
                  <td>Items</td>
                  <td>{batch.items.length}</td>
                </tr>
                <tr>
                  <td>Estimated words</td>
                  <td>{wordCount.toLocaleString()}</td>
                </tr>
                <tr>
                  <td>Naming pattern</td>
                  <td>{batch.workUnitNamePattern || "—"}</td>
                </tr>
              </tbody>
            </table>

            <h3>Updated on Webflow</h3>
            {batch.updates.length === 0 ? (
              <p className="hint">No translations pushed back to Webflow yet.</p>
            ) : (
              batch.updates.map((update, i) => {
                const errors = (update.resultsByItem || []).flatMap((item) =>
                  (item.resultsByLocale || [])
                    .filter((l) => l.error)
                    .map((l) => `${item.webflowItemId} (${l.locale}): ${l.error}`)
                );
                return (
                  <table className="kv-table" key={i}>
                    <tbody>
                      <tr>
                        <td>Pushed at</td>
                        <td>{new Date(update.updatedAt).toLocaleString()}</td>
                      </tr>
                      <tr>
                        <td>Locales</td>
                        <td>{update.targetLocales.join(", ")}</td>
                      </tr>
                      <tr>
                        <td>Items updated</td>
                        <td>{update.itemsUpdated}</td>
                      </tr>
                      <tr>
                        <td>Words updated</td>
                        <td>{update.wordCount.toLocaleString()}</td>
                      </tr>
                      <tr>
                        <td>Published</td>
                        <td>{update.autoPublish ? "yes" : "no (left as Draft)"}</td>
                      </tr>
                      {errors.length > 0 && (
                        <tr>
                          <td>Errors</td>
                          <td className="error">
                            {errors.map((e, j) => (
                              <div key={j}>{e}</div>
                            ))}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                );
              })
            )}
          </section>
        );
      })}
    </div>
  );
}
