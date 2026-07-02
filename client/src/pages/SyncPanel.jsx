import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api.js";
import StatusBadge from "../components/StatusBadge.jsx";

const POLL_INTERVAL_MS = 1500;

// Fixed for now -- there's no UI to configure this yet, just to show it.
const WORKFLOW_STEPS = ["TRANSLATION"];

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

const tabClass = (active) =>
  "rounded-md px-4 py-2 text-sm font-medium transition-colors " +
  (active ? "bg-slate-900 text-white" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50");

export default function SyncPanel() {
  const [mode, setMode] = useState("full");
  const [translateFromDate, setTranslateFromDate] = useState("");

  const [collections, setCollections] = useState([]);
  const [orgUnits, setOrgUnits] = useState([]);
  const [settings, setSettings] = useState(null);
  const [orgUnitResources, setOrgUnitResources] = useState(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [items, setItems] = useState([]);
  const [selectedItemIds, setSelectedItemIds] = useState([]);

  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [job, setJob] = useState(null);
  const pollRef = useRef(null);

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const [autoSyncStatus, setAutoSyncStatus] = useState(null);
  const autoSyncPollRef = useRef(null);

  useEffect(() => {
    api.getCollections().then((res) => setCollections(res.collections || []));
    api.getOrgUnits().then((res) => setOrgUnits(res.orgUnits || [])).catch(() => {});
    api.getSettings().then((res) => {
      setSettings(res);
      if (res.orgUnitUUID) {
        api.getOrgUnitResources(res.orgUnitUUID).then(setOrgUnitResources).catch(() => {});
      }
    });
    return () => clearInterval(pollRef.current);
  }, []);

  function orgUnitName(uuid) {
    const o = orgUnits.find((o) => o.uuid === uuid);
    return o ? o.name : uuid;
  }

  useEffect(() => {
    if (!selectedCollectionId) {
      setItems([]);
      return;
    }
    api.getCollectionItems(selectedCollectionId).then((res) => setItems(res.items || []));
    setSelectedItemIds([]);
  }, [selectedCollectionId]);

  useEffect(() => {
    if (mode !== "auto") {
      clearInterval(autoSyncPollRef.current);
      return;
    }
    const poll = () => api.getAutoSyncStatus().then(setAutoSyncStatus).catch((err) => setError(err.message));
    poll();
    autoSyncPollRef.current = setInterval(poll, POLL_INTERVAL_MS * 4);
    return () => clearInterval(autoSyncPollRef.current);
  }, [mode]);

  function toggleItem(itemId) {
    setSelectedItemIds((prev) =>
      prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]
    );
  }

  function toggleAllItems() {
    setSelectedItemIds((prev) => (prev.length === items.length ? [] : items.map((it) => it.id)));
  }

  async function previewFullSync() {
    setPreviewing(true);
    setError(null);
    try {
      const res = await api.previewBulkSync(translateFromDate || undefined);
      setPreview(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setPreviewing(false);
    }
  }

  function pollJob(jobId) {
    pollRef.current = setInterval(async () => {
      try {
        const latest = await api.getBulkSyncJob(jobId);
        setJob(latest);
        if (latest.status !== "running") {
          clearInterval(pollRef.current);
        }
      } catch (err) {
        clearInterval(pollRef.current);
        setError(err.message);
      }
    }, POLL_INTERVAL_MS);
  }

  async function launchFullSync() {
    setError(null);
    setJob(null);
    try {
      const res = await api.syncBulk(translateFromDate || undefined);
      setJob({
        id: res.jobId,
        total: res.total,
        processed: 0,
        status: "running",
        results: [],
        wxrksProjectUUID: res.wxrksProjectUUID,
      });
      pollJob(res.jobId); // first poll tick replaces this with the authoritative job record
    } catch (err) {
      setError(err.message);
    }
  }

  async function cancelFullSync() {
    if (!job) return;
    try {
      await api.cancelBulkSyncJob(job.id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function launchItemSync() {
    if (!selectedCollectionId || selectedItemIds.length === 0) {
      setError("Select a collection and at least one item.");
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.syncItem(selectedCollectionId, selectedItemIds);
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-slate-900">Sync Panel</h1>

      {settings && (
        <section className="mb-6 rounded-lg border border-slate-200 bg-slate-50 p-5">
          <h2 className="mb-3 text-base font-semibold text-slate-900">Current settings</h2>
          <ul className="space-y-1.5 text-sm text-slate-700">
            <li>
              <span className="font-medium text-slate-500">Org unit:</span>{" "}
              {settings.orgUnitUUID ? (
                orgUnitName(settings.orgUnitUUID)
              ) : (
                <em className="text-slate-400">not set — configure in Settings</em>
              )}
            </li>
            <li>
              <span className="font-medium text-slate-500">Translation memories:</span>{" "}
              {orgUnitResources
                ? orgUnitResources.translationMemories.map((tm) => tm.name).join(", ") || "none"
                : "—"}
            </li>
            <li>
              <span className="font-medium text-slate-500">Target languages:</span>{" "}
              {settings.targetLocales.length > 0 ? (
                settings.targetLocales.join(", ")
              ) : (
                <em className="text-slate-400">not set — configure in Settings</em>
              )}
            </li>
            <li>
              <span className="font-medium text-slate-500">Workflow steps:</span> {WORKFLOW_STEPS.join(" → ")}
            </li>
          </ul>
        </section>
      )}

      <div className="mb-5 flex gap-2">
        <button className={tabClass(mode === "full")} onClick={() => setMode("full")}>
          Full Sync
        </button>
        <button className={tabClass(mode === "item")} onClick={() => setMode("item")}>
          Item Sync
        </button>
        <button className={tabClass(mode === "auto")} onClick={() => setMode("auto")}>
          Auto Sync
        </button>
      </div>

      {mode === "full" && (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-base font-semibold text-slate-900">Full Sync</h2>
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Translate items updated since:
            <input
              type="date"
              value={translateFromDate}
              onChange={(e) => {
                setTranslateFromDate(e.target.value);
                setPreview(null);
              }}
              className="w-56 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </label>
          <p className="mt-1 text-xs text-slate-500">Leave blank to sync all items in all collections.</p>

          <div className="mt-4 flex gap-2">
            <button
              onClick={previewFullSync}
              disabled={previewing || job?.status === "running"}
              className="rounded-md border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {previewing ? "Checking..." : "Preview"}
            </button>
            <button
              onClick={launchFullSync}
              disabled={!preview || preview.totalItems === 0 || job?.status === "running"}
              className="rounded-md bg-brand-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Launch Full Sync
            </button>
          </div>

          {preview && (
            <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
              {preview.totalItems === 0 ? (
                <p>No items match this filter — nothing to sync.</p>
              ) : (
                <>
                  <p>
                    This will create <strong>one wxrks project</strong> containing{" "}
                    <strong>{preview.totalItems}</strong> item(s) across{" "}
                    {Object.keys(preview.byCollection).length} collection(s):
                  </p>
                  <ul className="mt-2 list-inside list-disc space-y-0.5">
                    {Object.entries(preview.byCollection).map(([name, count]) => (
                      <li key={name}>
                        {name}: {count}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2">
                    Estimated words to translate: <strong>{preview.estimatedWordCount?.toLocaleString()}</strong>
                  </p>
                </>
              )}
              <p className="mt-2 text-xs text-slate-500">Change the date and preview again to refresh this count.</p>
            </div>
          )}

          {job && (
            <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-4">
              <div className="mb-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full bg-green-600 transition-all duration-300"
                  style={{ width: `${job.total ? Math.round((job.processed / job.total) * 100) : 0}%` }}
                />
              </div>
              <p className="text-sm text-slate-700">
                {job.processed} / {job.total} processed — <strong>{job.status}</strong>
              </p>
              <ul className="mt-2 space-y-1 text-sm text-slate-600">
                {job.wxrksProjectUUID && <li>wxrks project: {job.wxrksProjectUUID}</li>}
                {job.orgUnitUUID && <li>Org unit: {orgUnitName(job.orgUnitUUID)}</li>}
                {job.targetLocales?.length > 0 && <li>Target locales: {job.targetLocales.join(", ")}</li>}
                {job.results?.length > 0 && (
                  <li>
                    Estimated words: {job.results.reduce((sum, r) => sum + (r.wordCount || 0), 0).toLocaleString()}
                  </li>
                )}
              </ul>
              {job.status === "running" && (
                <button
                  onClick={cancelFullSync}
                  className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
                >
                  Cancel
                </button>
              )}
              {job.status !== "running" && job.results.length > 0 && (
                <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">
                  {JSON.stringify(job.results, null, 2)}
                </pre>
              )}
            </div>
          )}
        </section>
      )}

      {mode === "item" && (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-base font-semibold text-slate-900">Item Sync</h2>
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Collection:
            <select
              value={selectedCollectionId}
              onChange={(e) => setSelectedCollectionId(e.target.value)}
              className="w-72 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="">Select a collection</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName || c.singularName}
                </option>
              ))}
            </select>
          </label>

          {items.length > 0 && (
            <div className="mt-4 max-h-96 overflow-auto rounded-md border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="w-8 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedItemIds.length === items.length}
                        onChange={toggleAllItems}
                        className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500"
                      />
                    </th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Date published</th>
                    <th className="px-3 py-2">Status</th>
                    {settings?.targetLocales.map((locale) => (
                      <th key={locale} className="px-3 py-2">
                        {locale}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selectedItemIds.includes(item.id)}
                          onChange={() => toggleItem(item.id)}
                          className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500"
                        />
                      </td>
                      <td className="px-3 py-2 text-slate-900">{item.name}</td>
                      <td className="px-3 py-2 text-slate-600">{formatDate(item.lastPublished)}</td>
                      <td className="px-3 py-2">
                        {item.isArchived ? (
                          <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                            Archived
                          </span>
                        ) : item.isDraft ? (
                          <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
                            Draft
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                            Published
                          </span>
                        )}
                      </td>
                      {settings?.targetLocales.map((locale) => (
                        <td key={locale} className="px-3 py-2">
                          <StatusBadge status={item.localeStatus?.[locale]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selectedItemIds.length > 0 && (
            <p className="mt-3 text-sm text-slate-600">
              This will create <strong>one wxrks project</strong> containing{" "}
              <strong>{selectedItemIds.length}</strong> item(s).
            </p>
          )}

          <button
            onClick={launchItemSync}
            disabled={running || selectedItemIds.length === 0}
            className="mt-4 rounded-md bg-brand-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? "Running..." : "Launch Item Sync"}
          </button>
        </section>
      )}

      {mode === "auto" && (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-base font-semibold text-slate-900">Auto Sync</h2>
          {!autoSyncStatus ? (
            <p className="text-sm text-slate-500">Loading status...</p>
          ) : !autoSyncStatus.enabled ? (
            <p className="text-sm text-slate-600">
              Auto Sync is disabled. Turn it on and configure which collections/conditions qualify in{" "}
              <Link to="/settings" className="font-medium text-brand-600 hover:underline">
                Settings → Auto Sync
              </Link>
              .
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                  Enabled
                </span>
                <span
                  className={
                    "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium " +
                    (autoSyncStatus.webhookStatus === "active"
                      ? "bg-green-100 text-green-800"
                      : "bg-red-100 text-red-800")
                  }
                >
                  webhook: {autoSyncStatus.webhookStatus.replace("_", " ")}
                </span>
              </div>
              <ul className="mt-3 space-y-1 text-sm text-slate-700">
                <li>
                  Pending items queued: <strong>{autoSyncStatus.pendingCount}</strong>
                  {autoSyncStatus.pendingSince && (
                    <> (oldest since {new Date(autoSyncStatus.pendingSince).toLocaleString()})</>
                  )}
                </li>
                <li>Flushes per day: {autoSyncStatus.flushesPerDay}</li>
                {autoSyncStatus.nextFlushEstimateAt && (
                  <li>Next flush (estimate): {new Date(autoSyncStatus.nextFlushEstimateAt).toLocaleString()}</li>
                )}
                {autoSyncStatus.webhookLastEventAt && (
                  <li>Last webhook event: {new Date(autoSyncStatus.webhookLastEventAt).toLocaleString()}</li>
                )}
              </ul>
              {autoSyncStatus.webhookStatus !== "active" && (
                <p className="mt-3 text-sm text-amber-700">
                  The Webflow webhook isn't active -- go to{" "}
                  <Link to="/settings" className="font-medium text-brand-600 hover:underline">
                    Settings → Auto Sync
                  </Link>{" "}
                  to re-register it.
                </p>
              )}
            </>
          )}
        </section>
      )}

      {error && <p className="mt-4 text-sm font-medium text-red-600">Error: {error}</p>}

      {result && (
        <section className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-base font-semibold text-slate-900">Result</h2>
          <ul className="space-y-1 text-sm text-slate-700">
            <li>wxrks project: {result.wxrksProjectUUID}</li>
            <li>Org unit: {orgUnitName(result.orgUnitUUID)}</li>
            <li>Target locales: {result.targetLocales?.join(", ")}</li>
            <li>
              Items: {result.itemsSynced} synced, {result.skipped} skipped, {result.errors} error(s)
            </li>
            <li>Estimated words: {result.estimatedWordCount?.toLocaleString()}</li>
          </ul>
          <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">
            {JSON.stringify(result.results, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}
