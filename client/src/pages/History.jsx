import { useEffect, useState } from "react";
import api from "../services/api.js";
import { wxrksProjectUrl } from "../wxrksLinks.js";
import { formatDateTime } from "../formatDate.js";

const linkClass = "font-medium text-brand-600 hover:text-brand-700 hover:underline";

export default function History() {
  const [history, setHistory] = useState(null);
  const [collections, setCollections] = useState([]);
  const [orgUnits, setOrgUnits] = useState([]);
  const [timezone, setTimezone] = useState(undefined);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      api.getSyncHistory(),
      api.getCollections().catch(() => ({ collections: [] })),
      api.getOrgUnits().catch(() => ({ orgUnits: [] })),
      api.getSettings().catch(() => null),
    ])
      .then(([historyRes, collectionsRes, orgUnitsRes, settingsRes]) => {
        setHistory(historyRes.history || []);
        setCollections(collectionsRes.collections || []);
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

  function orgUnitName(uuid) {
    const o = orgUnits.find((o) => o.uuid === uuid);
    return o ? o.name : uuid;
  }

  if (error) return <p className="text-sm font-medium text-red-600">Error: {error}</p>;
  if (!history) return <p className="text-slate-600">Loading history...</p>;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-slate-900">History</h1>
      {history.length === 0 && <p className="text-sm text-slate-600">No sync batches yet.</p>}

      {history.map((batch) => {
        const wordCount = batch.items.reduce((sum, i) => sum + (i.wordCount || 0), 0);
        return (
          <section
            className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
            id={batch.wxrksProjectUUID}
            key={batch.wxrksProjectUUID}
          >
            <h2 className="break-all text-sm font-mono font-semibold text-slate-900">{batch.wxrksProjectUUID}</h2>
            <p className="mt-1">
              <a href={wxrksProjectUrl(batch.wxrksProjectUUID)} target="_blank" rel="noreferrer" className={linkClass}>
                Open in wxrks
              </a>
            </p>

            <h3 className="mb-2 mt-4 text-sm font-semibold uppercase tracking-wide text-slate-500">Sent to wxrks</h3>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                <tr>
                  <td className="py-1 pr-4 font-medium text-slate-500">Created</td>
                  <td className="py-1 text-slate-800">{formatDateTime(batch.createdAt, timezone)}</td>
                </tr>
                <tr>
                  <td className="py-1 pr-4 font-medium text-slate-500">Mode</td>
                  <td className="py-1 text-slate-800">{batch.mode}</td>
                </tr>
                <tr>
                  <td className="py-1 pr-4 font-medium text-slate-500">Status</td>
                  <td className="py-1 text-slate-800">
                    {batch.status} ({batch.wxrksStatus})
                  </td>
                </tr>
                <tr>
                  <td className="py-1 pr-4 font-medium text-slate-500">Org unit</td>
                  <td className="py-1 text-slate-800">{batch.orgUnitUUID ? orgUnitName(batch.orgUnitUUID) : "—"}</td>
                </tr>
                <tr>
                  <td className="py-1 pr-4 font-medium text-slate-500">Source locale</td>
                  <td className="py-1 text-slate-800">{batch.sourceLocale}</td>
                </tr>
                <tr>
                  <td className="py-1 pr-4 font-medium text-slate-500">Target locales</td>
                  <td className="py-1 text-slate-800">{batch.targetLocales.join(", ")}</td>
                </tr>
                <tr>
                  <td className="py-1 pr-4 font-medium text-slate-500">Collections</td>
                  <td className="py-1 text-slate-800">{batch.collectionIds.map(collectionName).join(", ") || "—"}</td>
                </tr>
                <tr>
                  <td className="py-1 pr-4 font-medium text-slate-500">Items</td>
                  <td className="py-1 text-slate-800">{batch.items.length}</td>
                </tr>
                <tr>
                  <td className="py-1 pr-4 font-medium text-slate-500">Estimated words</td>
                  <td className="py-1 text-slate-800">{wordCount.toLocaleString()}</td>
                </tr>
                <tr>
                  <td className="py-1 pr-4 font-medium text-slate-500">Naming pattern</td>
                  <td className="py-1 font-mono text-xs text-slate-800">{batch.workUnitNamePattern || "—"}</td>
                </tr>
              </tbody>
            </table>

            <h3 className="mb-2 mt-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Updated on Webflow
            </h3>
            {batch.updates.length === 0 ? (
              <p className="text-sm text-slate-500">No translations pushed back to Webflow yet.</p>
            ) : (
              <div className="space-y-3">
                {batch.updates.map((update, i) => {
                  const errors = (update.resultsByItem || []).flatMap((item) =>
                    (item.resultsByLocale || [])
                      .filter((l) => l.error)
                      .map((l) => `${item.webflowItemId} (${l.locale}): ${l.error}`)
                  );
                  return (
                    <table key={i} className="w-full rounded-md border border-slate-200 bg-slate-50 text-sm">
                      <tbody className="divide-y divide-slate-200">
                        <tr>
                          <td className="px-3 py-1.5 font-medium text-slate-500">Pushed at</td>
                          <td className="px-3 py-1.5 text-slate-800">{formatDateTime(update.updatedAt, timezone)}</td>
                        </tr>
                        <tr>
                          <td className="px-3 py-1.5 font-medium text-slate-500">Locales</td>
                          <td className="px-3 py-1.5 text-slate-800">{update.targetLocales.join(", ")}</td>
                        </tr>
                        <tr>
                          <td className="px-3 py-1.5 font-medium text-slate-500">Items updated</td>
                          <td className="px-3 py-1.5 text-slate-800">{update.itemsUpdated}</td>
                        </tr>
                        <tr>
                          <td className="px-3 py-1.5 font-medium text-slate-500">Words updated</td>
                          <td className="px-3 py-1.5 text-slate-800">{update.wordCount.toLocaleString()}</td>
                        </tr>
                        <tr>
                          <td className="px-3 py-1.5 font-medium text-slate-500">Published</td>
                          <td className="px-3 py-1.5 text-slate-800">
                            {update.autoPublish ? "yes" : "no (left as Draft)"}
                          </td>
                        </tr>
                        {errors.length > 0 && (
                          <tr>
                            <td className="px-3 py-1.5 font-medium text-slate-500">Errors</td>
                            <td className="px-3 py-1.5 text-red-600">
                              {errors.map((e, j) => (
                                <div key={j}>{e}</div>
                              ))}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
