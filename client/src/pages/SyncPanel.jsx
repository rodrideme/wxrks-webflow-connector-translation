import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api.js";
import StatusPill from "../components/StatusPill.jsx";
import Card from "../components/Card.jsx";
import ProgressBar from "../components/ProgressBar.jsx";
import SegmentedControl from "../components/SegmentedControl.jsx";
import UnderlineTabs from "../components/UnderlineTabs.jsx";
import { localeStatusPill } from "../statusHelpers.jsx";
import { formatDateTime, formatDateOnly } from "../formatDate.js";

const POLL_INTERVAL_MS = 1500;

// Fixed for now -- there's no UI to configure this yet, just to show it.
const WORKFLOW_STEPS = ["TRANSLATION"];

const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50";
const btnGhost =
  "inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-surface px-4 py-1.5 text-[13px] font-semibold text-ink transition-colors hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-50";
const inputClass =
  "rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

export default function SyncPanel() {
  const [entityType, setEntityType] = useState("cms");
  const [mode, setMode] = useState("bulk");
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
  const [flushing, setFlushing] = useState(false);
  const [flushError, setFlushError] = useState(null);
  const autoSyncPollRef = useRef(null);

  // Pages sync -- mirrors the CMS state above, but Pages only supports
  // Bulk/Item (no Auto Sync -- deferred, see the plan's "Deferred" section).
  const [pagesMode, setPagesMode] = useState("bulk");
  const [pages, setPages] = useState([]);
  const [selectedPageIds, setSelectedPageIds] = useState([]);
  const [pagesPreview, setPagesPreview] = useState(null);
  const [pagesPreviewing, setPagesPreviewing] = useState(false);
  const [pagesJob, setPagesJob] = useState(null);
  const pagesPollRef = useRef(null);
  const [pagesRunning, setPagesRunning] = useState(false);
  const [pagesResult, setPagesResult] = useState(null);
  const [pagesError, setPagesError] = useState(null);

  useEffect(() => {
    api.getCollections().then((res) => setCollections(res.collections || []));
    api.getOrgUnits().then((res) => setOrgUnits(res.orgUnits || [])).catch(() => {});
    api.getSettings().then((res) => {
      setSettings(res);
      if (res.orgUnitUUID) {
        api.getOrgUnitResources(res.orgUnitUUID).then(setOrgUnitResources).catch(() => {});
      }
    });
    return () => {
      clearInterval(pollRef.current);
      clearInterval(pagesPollRef.current);
    };
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

  useEffect(() => {
    if (entityType !== "pages" || pagesMode !== "item" || pages.length > 0) return;
    api.getPages().then((res) => setPages(res.pages || [])).catch((err) => setPagesError(err.message));
  }, [entityType, pagesMode]);

  async function flushAutoSyncNow() {
    setFlushing(true);
    setFlushError(null);
    try {
      await api.flushAutoSyncNow();
      const latest = await api.getAutoSyncStatus();
      setAutoSyncStatus(latest);
    } catch (err) {
      setFlushError(err.message);
    } finally {
      setFlushing(false);
    }
  }

  function toggleItem(itemId) {
    setSelectedItemIds((prev) =>
      prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]
    );
  }

  function toggleAllItems() {
    setSelectedItemIds((prev) => (prev.length === items.length ? [] : items.map((it) => it.id)));
  }

  async function previewBulkSync() {
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

  async function launchBulkSync() {
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

  async function cancelBulkSync() {
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

  function togglePage(pageId) {
    setSelectedPageIds((prev) => (prev.includes(pageId) ? prev.filter((id) => id !== pageId) : [...prev, pageId]));
  }

  function toggleAllPages() {
    setSelectedPageIds((prev) => (prev.length === pages.length ? [] : pages.map((p) => p.id)));
  }

  async function previewPagesBulkSync() {
    setPagesPreviewing(true);
    setPagesError(null);
    try {
      const res = await api.previewPagesBulkSync();
      setPagesPreview(res);
    } catch (err) {
      setPagesError(err.message);
    } finally {
      setPagesPreviewing(false);
    }
  }

  function pollPagesJob(jobId) {
    pagesPollRef.current = setInterval(async () => {
      try {
        const latest = await api.getPagesBulkSyncJob(jobId);
        setPagesJob(latest);
        if (latest.status !== "running") {
          clearInterval(pagesPollRef.current);
        }
      } catch (err) {
        clearInterval(pagesPollRef.current);
        setPagesError(err.message);
      }
    }, POLL_INTERVAL_MS);
  }

  async function launchPagesBulkSync() {
    setPagesError(null);
    setPagesJob(null);
    try {
      const res = await api.syncPagesBulk();
      setPagesJob({
        id: res.jobId,
        total: res.total,
        processed: 0,
        status: "running",
        results: [],
        wxrksProjectUUID: res.wxrksProjectUUID,
      });
      pollPagesJob(res.jobId);
    } catch (err) {
      setPagesError(err.message);
    }
  }

  async function cancelPagesBulkSync() {
    if (!pagesJob) return;
    try {
      await api.cancelPagesBulkSyncJob(pagesJob.id);
    } catch (err) {
      setPagesError(err.message);
    }
  }

  async function launchPagesItemSync() {
    if (selectedPageIds.length === 0) {
      setPagesError("Select at least one page.");
      return;
    }
    setPagesRunning(true);
    setPagesError(null);
    setPagesResult(null);
    try {
      const res = await api.syncPagesItem(selectedPageIds);
      setPagesResult(res);
    } catch (err) {
      setPagesError(err.message);
    } finally {
      setPagesRunning(false);
    }
  }

  const cmsTabs = [
    { value: "bulk", label: "Bulk Sync" },
    { value: "item", label: "Item Sync" },
    { value: "auto", label: "Auto Sync" },
  ];
  const pagesTabs = [
    { value: "bulk", label: "Bulk Sync" },
    { value: "item", label: "Item Sync" },
  ];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Sync Panel</h1>
        <SegmentedControl
          options={[
            { value: "cms", label: "CMS Items" },
            { value: "pages", label: "Pages" },
          ]}
          value={entityType}
          onChange={setEntityType}
        />
      </div>

      {settings && (
        <Card className="mb-6 p-4">
          <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-[13px] sm:grid-cols-4">
            <div>
              <div className="text-ink-faint">Org unit</div>
              <div className="font-medium text-ink">
                {settings.orgUnitUUID ? orgUnitName(settings.orgUnitUUID) : <em className="text-ink-faint">not set</em>}
              </div>
            </div>
            <div>
              <div className="text-ink-faint">Translation memories</div>
              <div className="font-medium text-ink">
                {orgUnitResources ? orgUnitResources.translationMemories.map((tm) => tm.name).join(", ") || "none" : "—"}
              </div>
            </div>
            <div>
              <div className="text-ink-faint">Target languages</div>
              <div className="font-medium text-ink">
                {settings.targetLocales.length > 0 ? settings.targetLocales.join(", ") : <em className="text-ink-faint">not set</em>}
              </div>
            </div>
            <div>
              <div className="text-ink-faint">Workflow</div>
              <div className="font-medium text-ink">{WORKFLOW_STEPS.join(" → ")}</div>
            </div>
          </div>
        </Card>
      )}

      {entityType === "cms" && (
        <>
          <UnderlineTabs options={cmsTabs} value={mode} onChange={setMode} className="mb-5" />

          {mode === "bulk" && (
            <Card accent>
              <div className="flex flex-wrap items-center justify-between gap-3 bg-accent-subtle p-4">
                <div>
                  <div className="text-[13px] font-semibold text-ink">Bulk Sync</div>
                  <div className="mt-0.5 text-xs text-ink-soft">Syncs every enabled collection in one wxrks project</div>
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-[13px] font-medium text-ink-soft">
                    Since
                    <input
                      type="date"
                      value={translateFromDate}
                      onChange={(e) => {
                        setTranslateFromDate(e.target.value);
                        setPreview(null);
                      }}
                      className={inputClass}
                    />
                  </label>
                  <button onClick={previewBulkSync} disabled={previewing || job?.status === "running"} className={btnGhost}>
                    {previewing ? "Checking..." : "Preview"}
                  </button>
                  <button
                    onClick={launchBulkSync}
                    disabled={!preview || preview.totalItems === 0 || job?.status === "running"}
                    className={btnPrimary}
                  >
                    Launch Bulk Sync
                  </button>
                </div>
              </div>

              <div className="p-4">
                <p className="text-xs text-ink-faint">Leave the date blank to sync all items in all collections.</p>

                {preview && (
                  <div className="mt-4 rounded-md border border-border bg-surface-sunken p-4 text-sm text-ink-soft">
                    {preview.totalItems === 0 ? (
                      <p>No items match this filter — nothing to sync.</p>
                    ) : (
                      <>
                        <p>
                          This will create <b className="text-ink">one wxrks project</b> containing{" "}
                          <b className="font-mono tabular-nums text-ink">{preview.totalItems}</b> item(s) across{" "}
                          {Object.keys(preview.byCollection).length} collection(s):
                        </p>
                        <ul className="mt-2 list-inside list-disc space-y-0.5">
                          {Object.entries(preview.byCollection).map(([name, count]) => (
                            <li key={name}>
                              {name}: <span className="font-mono tabular-nums">{count}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2">
                          Estimated words to translate:{" "}
                          <b className="font-mono tabular-nums text-ink">{preview.estimatedWordCount?.toLocaleString()}</b>
                        </p>
                      </>
                    )}
                  </div>
                )}

                {job && (
                  <div className="mt-4 rounded-md border border-border bg-surface-sunken p-4">
                    <div className="mb-2 flex items-center gap-3">
                      <StatusPill variant={job.status === "running" ? "progress" : job.status === "error" ? "error" : "success"} label={job.status} />
                      <span className="flex-1">
                        <ProgressBar value={job.processed} max={job.total} label={`${job.processed} / ${job.total} processed`} />
                      </span>
                    </div>
                    <ul className="mt-3 space-y-1 text-sm text-ink-soft">
                      {job.wxrksProjectUUID && <li className="font-mono text-xs">{job.wxrksProjectUUID}</li>}
                      {job.orgUnitUUID && <li>Org unit: {orgUnitName(job.orgUnitUUID)}</li>}
                      {job.targetLocales?.length > 0 && <li>Target locales: {job.targetLocales.join(", ")}</li>}
                      {job.results?.length > 0 && (
                        <li>
                          Estimated words:{" "}
                          <span className="font-mono tabular-nums">
                            {job.results.reduce((sum, r) => sum + (r.wordCount || 0), 0).toLocaleString()}
                          </span>
                        </li>
                      )}
                    </ul>
                    {job.status === "running" && (
                      <button
                        onClick={cancelBulkSync}
                        className="mt-3 rounded-md border border-status-error-fg/30 bg-surface px-3 py-1.5 text-sm font-medium text-status-error-fg hover:bg-status-error-bg"
                      >
                        Cancel
                      </button>
                    )}
                    {job.status !== "running" && job.results.length > 0 && (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-xs font-medium text-ink-faint">Raw results</summary>
                        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-surface p-3 text-xs text-ink-soft">
                          {JSON.stringify(job.results, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            </Card>
          )}

          {mode === "item" && (
            <Card accent>
              <div className="flex flex-wrap items-center justify-between gap-3 bg-accent-subtle p-4">
                <label className="flex items-center gap-2 text-[13px] font-medium text-ink-soft">
                  Collection
                  <select
                    value={selectedCollectionId}
                    onChange={(e) => setSelectedCollectionId(e.target.value)}
                    className={inputClass + " w-64"}
                  >
                    <option value="">Select a collection</option>
                    {collections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.displayName || c.singularName}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  onClick={launchItemSync}
                  disabled={running || selectedItemIds.length === 0}
                  className={btnPrimary}
                >
                  {running ? "Running..." : "Launch Item Sync"}
                </button>
              </div>

              {items.length > 0 && (
                <>
                  <div className="flex items-center justify-between border-b border-border bg-surface-sunken px-4 py-2.5 text-[12.5px] text-ink-soft">
                    <span>
                      <b className="font-mono tabular-nums text-ink">{selectedItemIds.length}</b> of {items.length} items
                      selected
                    </span>
                  </div>
                  <div className="max-h-96 overflow-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="sticky top-0 z-10 bg-surface-sunken text-[10.5px] font-bold uppercase tracking-wide text-ink-faint">
                        <tr>
                          <th className="w-8 px-4 py-2">
                            <input
                              type="checkbox"
                              checked={selectedItemIds.length === items.length}
                              onChange={toggleAllItems}
                            />
                          </th>
                          <th className="whitespace-nowrap px-3 py-2">Name</th>
                          <th className="whitespace-nowrap px-3 py-2">Date published</th>
                          <th className="whitespace-nowrap px-3 py-2">Status</th>
                          {settings?.targetLocales.map((locale) => (
                            <th key={locale} className="px-3 py-2">
                              {locale}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {items.map((item) => (
                          <tr key={item.id} className="hover:bg-surface-sunken">
                            <td className="px-4 py-2.5">
                              <input
                                type="checkbox"
                                checked={selectedItemIds.includes(item.id)}
                                onChange={() => toggleItem(item.id)}
                              />
                            </td>
                            <td className="px-3 py-2.5 font-medium text-ink">{item.name}</td>
                            <td className="px-3 py-2.5 font-mono text-xs text-ink-faint">
                              {formatDateOnly(item.lastPublished, settings?.timezone)}
                            </td>
                            <td className="px-3 py-2.5">
                              {item.isArchived ? (
                                <StatusPill variant="draft" label="Archived" />
                              ) : item.isDraft ? (
                                <StatusPill variant="progress" label="Draft" />
                              ) : (
                                <StatusPill variant="success" label="Published" />
                              )}
                            </td>
                            {settings?.targetLocales.map((locale) => (
                              <td key={locale} className="px-3 py-2.5">
                                {localeStatusPill(item.localeStatus?.[locale])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Card>
          )}

          {mode === "auto" && (
            <Card className="p-5">
              {!autoSyncStatus ? (
                <p className="text-sm text-ink-soft">Loading status...</p>
              ) : !autoSyncStatus.enabled ? (
                <p className="text-sm text-ink-soft">
                  Auto Sync is disabled. Turn it on and configure which collections/conditions qualify in{" "}
                  <Link to="/settings" className="font-medium text-accent-text hover:underline">
                    Settings → Auto Sync
                  </Link>
                  .
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <StatusPill variant="auto" />
                    {autoSyncStatus.webhookStatus === "active" ? (
                      <StatusPill variant="success" label="Webhook active" />
                    ) : (
                      <StatusPill variant="error" label={`Webhook ${autoSyncStatus.webhookStatus.replace("_", " ")}`} />
                    )}
                  </div>
                  <ul className="mt-3 space-y-1 text-sm text-ink-soft">
                    <li>
                      Flush times ({autoSyncStatus.timezone}):{" "}
                      <span className="font-mono">{autoSyncStatus.flushTimes?.join(", ")}</span>
                    </li>
                    {autoSyncStatus.nextFlushAt && (
                      <li>Next flush: {formatDateTime(autoSyncStatus.nextFlushAt, autoSyncStatus.timezone)}</li>
                    )}
                    {autoSyncStatus.webhookLastEventAt && (
                      <li>Last webhook event: {formatDateTime(autoSyncStatus.webhookLastEventAt, autoSyncStatus.timezone)}</li>
                    )}
                  </ul>

                  <div className="mt-4 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-ink">
                      Pending queue (<span className="font-mono tabular-nums">{autoSyncStatus.pendingCount}</span>)
                    </h3>
                    <button onClick={flushAutoSyncNow} disabled={flushing || autoSyncStatus.pendingCount === 0} className={btnGhost}>
                      {flushing ? "Flushing..." : "Flush now"}
                    </button>
                  </div>
                  {flushError && <p className="mt-1 text-xs font-medium text-status-error-fg">{flushError}</p>}

                  {autoSyncStatus.pendingItems?.length > 0 && (
                    <div className="mt-2 max-h-64 overflow-auto rounded-md border border-border">
                      <table className="w-full text-left text-sm">
                        <thead className="sticky top-0 bg-surface-sunken text-[10.5px] font-bold uppercase tracking-wide text-ink-faint">
                          <tr>
                            <th className="whitespace-nowrap px-3 py-2">Item</th>
                            <th className="whitespace-nowrap px-3 py-2">Collection</th>
                            <th className="whitespace-nowrap px-3 py-2">Queued at</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {autoSyncStatus.pendingItems.map((p) => (
                            <tr key={`${p.collectionId}:${p.itemId}`}>
                              <td className="px-3 py-2 text-ink">{p.itemName}</td>
                              <td className="px-3 py-2 text-ink-soft">{p.collectionName}</td>
                              <td className="px-3 py-2 font-mono text-xs text-ink-faint">
                                {formatDateTime(p.enqueuedAt, autoSyncStatus.timezone)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {autoSyncStatus.webhookStatus !== "active" && (
                    <p className="mt-3 text-sm text-status-progress-fg">
                      The Webflow webhook isn't active -- go to{" "}
                      <Link to="/settings" className="font-medium text-accent-text hover:underline">
                        Settings → Auto Sync
                      </Link>{" "}
                      to re-register it.
                    </p>
                  )}
                </>
              )}
            </Card>
          )}

          {error && <p className="mt-4 text-sm font-medium text-status-error-fg">Error: {error}</p>}

          {result && (
            <Card className="mt-6 p-5">
              <h2 className="mb-3 text-[13.5px] font-semibold text-ink">Result</h2>
              <ul className="space-y-1 text-sm text-ink-soft">
                <li className="font-mono text-xs">{result.wxrksProjectUUID}</li>
                <li>Org unit: {orgUnitName(result.orgUnitUUID)}</li>
                <li>Target locales: {result.targetLocales?.join(", ")}</li>
                <li>
                  Items: <span className="font-mono tabular-nums">{result.itemsSynced}</span> synced,{" "}
                  <span className="font-mono tabular-nums">{result.skipped}</span> skipped,{" "}
                  <span className="font-mono tabular-nums">{result.errors}</span> error(s)
                </li>
                <li>Estimated words: <span className="font-mono tabular-nums">{result.estimatedWordCount?.toLocaleString()}</span></li>
              </ul>
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-medium text-ink-faint">Raw results</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-surface-sunken p-3 text-xs text-ink-soft">
                  {JSON.stringify(result.results, null, 2)}
                </pre>
              </details>
            </Card>
          )}
        </>
      )}

      {entityType === "pages" && (
        <>
          <UnderlineTabs options={pagesTabs} value={pagesMode} onChange={setPagesMode} className="mb-5" />

          {pagesMode === "bulk" && (
            <Card accent>
              <div className="flex flex-wrap items-center justify-between gap-3 bg-accent-subtle p-4">
                <div>
                  <div className="text-[13px] font-semibold text-ink">Pages Bulk Sync</div>
                  <div className="mt-0.5 text-xs text-ink-soft">Syncs every enabled static page (see Settings → Pages)</div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={previewPagesBulkSync}
                    disabled={pagesPreviewing || pagesJob?.status === "running"}
                    className={btnGhost}
                  >
                    {pagesPreviewing ? "Checking..." : "Preview"}
                  </button>
                  <button
                    onClick={launchPagesBulkSync}
                    disabled={!pagesPreview || pagesPreview.totalPages === 0 || pagesJob?.status === "running"}
                    className={btnPrimary}
                  >
                    Launch Bulk Sync
                  </button>
                </div>
              </div>

              <div className="p-4">
                {pagesPreview && (
                  <div className="rounded-md border border-border bg-surface-sunken p-4 text-sm text-ink-soft">
                    {pagesPreview.totalPages === 0 ? (
                      <p>No pages match the current filter — nothing to sync.</p>
                    ) : (
                      <p>
                        This will create <b className="text-ink">one wxrks project</b> containing{" "}
                        <b className="font-mono tabular-nums text-ink">{pagesPreview.totalPages}</b> page(s). Estimated
                        words to translate:{" "}
                        <b className="font-mono tabular-nums text-ink">{pagesPreview.estimatedWordCount?.toLocaleString()}</b>
                      </p>
                    )}
                  </div>
                )}

                {pagesJob && (
                  <div className="mt-4 rounded-md border border-border bg-surface-sunken p-4">
                    <div className="mb-2 flex items-center gap-3">
                      <StatusPill
                        variant={pagesJob.status === "running" ? "progress" : pagesJob.status === "error" ? "error" : "success"}
                        label={pagesJob.status}
                      />
                      <span className="flex-1">
                        <ProgressBar value={pagesJob.processed} max={pagesJob.total} label={`${pagesJob.processed} / ${pagesJob.total} processed`} />
                      </span>
                    </div>
                    <ul className="mt-3 space-y-1 text-sm text-ink-soft">
                      {pagesJob.wxrksProjectUUID && <li className="font-mono text-xs">{pagesJob.wxrksProjectUUID}</li>}
                      {pagesJob.targetLocales?.length > 0 && <li>Target locales: {pagesJob.targetLocales.join(", ")}</li>}
                      {pagesJob.results?.length > 0 && (
                        <li>
                          Estimated words:{" "}
                          <span className="font-mono tabular-nums">
                            {pagesJob.results.reduce((sum, r) => sum + (r.wordCount || 0), 0).toLocaleString()}
                          </span>
                        </li>
                      )}
                    </ul>
                    {pagesJob.status === "running" && (
                      <button
                        onClick={cancelPagesBulkSync}
                        className="mt-3 rounded-md border border-status-error-fg/30 bg-surface px-3 py-1.5 text-sm font-medium text-status-error-fg hover:bg-status-error-bg"
                      >
                        Cancel
                      </button>
                    )}
                    {pagesJob.status !== "running" && pagesJob.results.length > 0 && (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-xs font-medium text-ink-faint">Raw results</summary>
                        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-surface p-3 text-xs text-ink-soft">
                          {JSON.stringify(pagesJob.results, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            </Card>
          )}

          {pagesMode === "item" && (
            <Card accent>
              <div className="flex items-center justify-between bg-accent-subtle p-4">
                <div className="text-[13px] font-semibold text-ink">Select pages to sync</div>
                <button
                  onClick={launchPagesItemSync}
                  disabled={pagesRunning || selectedPageIds.length === 0}
                  className={btnPrimary}
                >
                  {pagesRunning ? "Running..." : "Launch Item Sync"}
                </button>
              </div>

              {pages.length > 0 && (
                <>
                  <div className="flex items-center justify-between border-b border-border bg-surface-sunken px-4 py-2.5 text-[12.5px] text-ink-soft">
                    <span>
                      <b className="font-mono tabular-nums text-ink">{selectedPageIds.length}</b> of {pages.length} pages
                      selected
                    </span>
                  </div>
                  <div className="max-h-96 overflow-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="sticky top-0 z-10 bg-surface-sunken text-[10.5px] font-bold uppercase tracking-wide text-ink-faint">
                        <tr>
                          <th className="w-8 px-4 py-2">
                            <input
                              type="checkbox"
                              checked={selectedPageIds.length === pages.length}
                              onChange={toggleAllPages}
                            />
                          </th>
                          <th className="whitespace-nowrap px-3 py-2">Page</th>
                          <th className="whitespace-nowrap px-3 py-2">Slug</th>
                          <th className="whitespace-nowrap px-3 py-2">Last updated</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {pages.map((page) => (
                          <tr key={page.id} className="hover:bg-surface-sunken">
                            <td className="px-4 py-2.5">
                              <input
                                type="checkbox"
                                checked={selectedPageIds.includes(page.id)}
                                onChange={() => togglePage(page.id)}
                              />
                            </td>
                            <td className="px-3 py-2.5 font-medium text-ink">{page.title}</td>
                            <td className="px-3 py-2.5 font-mono text-xs text-ink-faint">{page.slug}</td>
                            <td className="px-3 py-2.5 font-mono text-xs text-ink-faint">
                              {formatDateOnly(page.lastUpdated, settings?.timezone)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Card>
          )}

          {pagesError && <p className="mt-4 text-sm font-medium text-status-error-fg">Error: {pagesError}</p>}

          {pagesResult && (
            <Card className="mt-6 p-5">
              <h2 className="mb-3 text-[13.5px] font-semibold text-ink">Result</h2>
              <ul className="space-y-1 text-sm text-ink-soft">
                <li className="font-mono text-xs">{pagesResult.wxrksProjectUUID}</li>
                <li>Target locales: {pagesResult.targetLocales?.join(", ")}</li>
                <li>
                  Pages: <span className="font-mono tabular-nums">{pagesResult.itemsSynced}</span> synced,{" "}
                  <span className="font-mono tabular-nums">{pagesResult.skipped}</span> skipped,{" "}
                  <span className="font-mono tabular-nums">{pagesResult.errors}</span> error(s)
                </li>
                <li>Estimated words: <span className="font-mono tabular-nums">{pagesResult.estimatedWordCount?.toLocaleString()}</span></li>
              </ul>
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-medium text-ink-faint">Raw results</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-surface-sunken p-3 text-xs text-ink-soft">
                  {JSON.stringify(pagesResult.results, null, 2)}
                </pre>
              </details>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
