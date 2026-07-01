import { useEffect, useRef, useState } from "react";
import api from "../services/api.js";

const POLL_INTERVAL_MS = 1500;

// Fixed for now -- there's no UI to configure this yet, just to show it.
const WORKFLOW_STEPS = ["TRANSLATION"];

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

  function toggleItem(itemId) {
    setSelectedItemIds((prev) =>
      prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]
    );
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
      <h1>Sync Panel</h1>

      {settings && (
        <section className="card settings-summary">
          <h2>Current settings</h2>
          <ul>
            <li>
              Org unit:{" "}
              {settings.orgUnitUUID ? orgUnitName(settings.orgUnitUUID) : <em>not set — configure in Settings</em>}
            </li>
            <li>
              Translation memories:{" "}
              {orgUnitResources
                ? orgUnitResources.translationMemories.map((tm) => tm.name).join(", ") || "none"
                : "—"}
            </li>
            <li>
              Target languages:{" "}
              {settings.targetLocales.length > 0 ? (
                settings.targetLocales.join(", ")
              ) : (
                <em>not set — configure in Settings</em>
              )}
            </li>
            <li>Workflow steps: {WORKFLOW_STEPS.join(" → ")}</li>
          </ul>
        </section>
      )}

      <div className="tabs">
        <button className={mode === "full" ? "tab active" : "tab"} onClick={() => setMode("full")}>
          Full Sync
        </button>
        <button className={mode === "item" ? "tab active" : "tab"} onClick={() => setMode("item")}>
          Item Sync
        </button>
      </div>

      {mode === "full" && (
        <section className="card">
          <h2>Full Sync</h2>
          <label>
            Translate items updated since:
            <input
              type="date"
              value={translateFromDate}
              onChange={(e) => {
                setTranslateFromDate(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <p className="hint">Leave blank to sync all items in all collections.</p>

          <button onClick={previewFullSync} disabled={previewing || job?.status === "running"}>
            {previewing ? "Checking..." : "Preview"}
          </button>{" "}
          <button
            onClick={launchFullSync}
            disabled={!preview || preview.totalItems === 0 || job?.status === "running"}
          >
            Launch Full Sync
          </button>

          {preview && (
            <div className="preview-box">
              {preview.totalItems === 0 ? (
                <p>No items match this filter — nothing to sync.</p>
              ) : (
                <>
                  <p>
                    This will create <strong>one wxrks project</strong> containing{" "}
                    <strong>{preview.totalItems}</strong> item(s) across{" "}
                    {Object.keys(preview.byCollection).length} collection(s):
                  </p>
                  <ul>
                    {Object.entries(preview.byCollection).map(([name, count]) => (
                      <li key={name}>
                        {name}: {count}
                      </li>
                    ))}
                  </ul>
                  <p>
                    Estimated words to translate: <strong>{preview.estimatedWordCount?.toLocaleString()}</strong>
                  </p>
                </>
              )}
              <p className="hint">Change the date and preview again to refresh this count.</p>
            </div>
          )}

          {job && (
            <div className="progress-box">
              <div className="progress-bar-track">
                <div
                  className="progress-bar-fill"
                  style={{ width: `${job.total ? Math.round((job.processed / job.total) * 100) : 0}%` }}
                />
              </div>
              <p>
                {job.processed} / {job.total} processed — <strong>{job.status}</strong>
              </p>
              <ul>
                {job.wxrksProjectUUID && <li>wxrks project: {job.wxrksProjectUUID}</li>}
                {job.orgUnitUUID && <li>Org unit: {orgUnitName(job.orgUnitUUID)}</li>}
                {job.targetLocales?.length > 0 && <li>Target locales: {job.targetLocales.join(", ")}</li>}
                {job.results?.length > 0 && (
                  <li>
                    Estimated words: {job.results.reduce((sum, r) => sum + (r.wordCount || 0), 0).toLocaleString()}
                  </li>
                )}
              </ul>
              {job.status === "running" && <button onClick={cancelFullSync}>Cancel</button>}
              {job.status !== "running" && job.results.length > 0 && (
                <pre>{JSON.stringify(job.results, null, 2)}</pre>
              )}
            </div>
          )}
        </section>
      )}

      {mode === "item" && (
        <section className="card">
          <h2>Item Sync</h2>
          <label>
            Collection:
            <select value={selectedCollectionId} onChange={(e) => setSelectedCollectionId(e.target.value)}>
              <option value="">Select a collection</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName || c.singularName}
                </option>
              ))}
            </select>
          </label>

          {items.length > 0 && (
            <ul className="item-checklist">
              {items.map((item) => (
                <li key={item.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedItemIds.includes(item.id)}
                      onChange={() => toggleItem(item.id)}
                    />
                    {item.name}
                  </label>
                </li>
              ))}
            </ul>
          )}

          {selectedItemIds.length > 0 && (
            <p className="hint">
              This will create <strong>one wxrks project</strong> containing{" "}
              <strong>{selectedItemIds.length}</strong> item(s).
            </p>
          )}

          <button onClick={launchItemSync} disabled={running || selectedItemIds.length === 0}>
            {running ? "Running..." : "Launch Item Sync"}
          </button>
        </section>
      )}

      {error && <p className="error">Error: {error}</p>}

      {result && (
        <section className="card">
          <h2>Result</h2>
          <ul>
            <li>wxrks project: {result.wxrksProjectUUID}</li>
            <li>Org unit: {orgUnitName(result.orgUnitUUID)}</li>
            <li>Target locales: {result.targetLocales?.join(", ")}</li>
            <li>
              Items: {result.itemsSynced} synced, {result.skipped} skipped, {result.errors} error(s)
            </li>
            <li>Estimated words: {result.estimatedWordCount?.toLocaleString()}</li>
          </ul>
          <pre>{JSON.stringify(result.results, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
