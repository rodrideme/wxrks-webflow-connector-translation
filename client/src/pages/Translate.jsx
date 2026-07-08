import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api.js";
import StatusPill from "../components/StatusPill.jsx";
import Card from "../components/Card.jsx";
import ProgressBar from "../components/ProgressBar.jsx";
import SegmentedControl from "../components/SegmentedControl.jsx";
import UnderlineTabs from "../components/UnderlineTabs.jsx";
import SyncSidebar from "../components/SyncSidebar.jsx";
import SyncActionBar from "../components/SyncActionBar.jsx";
import { formatDateTime, formatDateOnly } from "../formatDate.js";

const POLL_INTERVAL_MS = 1500;

const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50";
const btnGhost =
  "inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-surface px-4 py-1.5 text-[13px] font-semibold text-ink transition-colors hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-50";
const inputClass =
  "rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

// Per-locale status as a compact dot (CMS item table only -- Pages/
// Components don't have this data without an expensive per-row fetch, see
// the nav-restructuring plan).
const DOT_COLOR = {
  published: "bg-status-success-dot border-status-success-dot",
  draft: "bg-status-progress-dot border-status-progress-dot",
  missing: "bg-transparent border-border-strong",
};
const DOT_LABEL = { published: "Published", draft: "Draft", missing: "Missing" };
function LocaleDot({ status, locale }) {
  const cls = DOT_COLOR[status] || DOT_COLOR.missing;
  return (
    <span
      title={`${locale.toUpperCase()} — ${DOT_LABEL[status] || "Missing"}`}
      className={`inline-block h-[9px] w-[9px] rounded-full border-[1.5px] ${cls}`}
    />
  );
}

export default function Translate() {
  const [entityType, setEntityType] = useState("cms");
  const [mode, setMode] = useState("bulk");
  const [translateFromDate, setTranslateFromDate] = useState("");

  const [collections, setCollections] = useState([]);
  const [backlog, setBacklog] = useState([]);
  const [orgUnits, setOrgUnits] = useState([]);
  const [settings, setSettings] = useState(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [items, setItems] = useState([]);
  const [itemFilter, setItemFilter] = useState("all");
  const [selectedItemIds, setSelectedItemIds] = useState([]);

  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [job, setJob] = useState(null);
  const pollRef = useRef(null);

  const [itemPhase, setItemPhase] = useState("idle"); // idle | confirm | running | done
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
  const [pagesItemPhase, setPagesItemPhase] = useState("idle");
  const [pagesResult, setPagesResult] = useState(null);
  const [pagesError, setPagesError] = useState(null);

  // Components sync -- mirrors Pages' state, same Bulk/Item-only scope.
  const [componentsMode, setComponentsMode] = useState("bulk");
  const [components, setComponents] = useState([]);
  const [selectedComponentIds, setSelectedComponentIds] = useState([]);
  const [componentsPreview, setComponentsPreview] = useState(null);
  const [componentsPreviewing, setComponentsPreviewing] = useState(false);
  const [componentsJob, setComponentsJob] = useState(null);
  const componentsPollRef = useRef(null);
  const [componentsItemPhase, setComponentsItemPhase] = useState("idle");
  const [componentsResult, setComponentsResult] = useState(null);
  const [componentsError, setComponentsError] = useState(null);

  useEffect(() => {
    api.getCollections().then((res) => setCollections(res.collections || []));
    api.getBacklog().then((res) => setBacklog(res.backlog || [])).catch(() => {});
    api.getOrgUnits().then((res) => setOrgUnits(res.orgUnits || [])).catch(() => {});
    api.getSettings().then(setSettings);
    return () => {
      clearInterval(pollRef.current);
      clearInterval(pagesPollRef.current);
      clearInterval(componentsPollRef.current);
    };
  }, []);

  function orgUnitName(uuid) {
    const o = orgUnits.find((o) => o.uuid === uuid);
    return o ? o.name : uuid;
  }

  // Distinct pending-item count per collection, reusing the already-fetched
  // /api/backlog data instead of a new endpoint, for the collection pill
  // picker below.
  const backlogByCollection = collections.reduce((acc, c) => {
    const ids = new Set(backlog.filter((b) => b.collectionId === c.id).map((b) => b.itemId));
    acc[c.id] = ids.size;
    return acc;
  }, {});

  useEffect(() => {
    if (!selectedCollectionId) {
      setItems([]);
      return;
    }
    api.getCollectionItems(selectedCollectionId).then((res) => setItems(res.items || []));
    setSelectedItemIds([]);
    setItemFilter("all");
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

  useEffect(() => {
    if (entityType !== "components" || componentsMode !== "item" || components.length > 0) return;
    api.getComponents().then((res) => setComponents(res.components || [])).catch((err) => setComponentsError(err.message));
  }, [entityType, componentsMode]);

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

  const visibleItems =
    itemFilter === "needs"
      ? items.filter((it) => settings?.targetLocales.some((l) => it.localeStatus?.[l] !== "published"))
      : items;
  const selectedItems = items.filter((it) => selectedItemIds.includes(it.id));
  const selectedItemWords = selectedItems.reduce((sum, it) => sum + (it.wordCount || 0), 0);

  function toggleItem(itemId) {
    setSelectedItemIds((prev) => (prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]));
  }

  function toggleAllItems() {
    setSelectedItemIds((prev) => (prev.length === visibleItems.length ? [] : visibleItems.map((it) => it.id)));
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

  async function doLaunchItemSync() {
    setItemPhase("running");
    setError(null);
    try {
      const res = await api.syncItem(selectedCollectionId, selectedItemIds);
      setResult(res);
      setItemPhase("done");
    } catch (err) {
      setError(err.message);
      setItemPhase("idle");
    }
  }

  function resetItemSync() {
    setItemPhase("idle");
    setResult(null);
    setSelectedItemIds([]);
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

  async function doLaunchPagesItemSync() {
    setPagesItemPhase("running");
    setPagesError(null);
    try {
      const res = await api.syncPagesItem(selectedPageIds);
      setPagesResult(res);
      setPagesItemPhase("done");
    } catch (err) {
      setPagesError(err.message);
      setPagesItemPhase("idle");
    }
  }

  function resetPagesItemSync() {
    setPagesItemPhase("idle");
    setPagesResult(null);
    setSelectedPageIds([]);
  }

  function toggleComponent(componentId) {
    setSelectedComponentIds((prev) =>
      prev.includes(componentId) ? prev.filter((id) => id !== componentId) : [...prev, componentId]
    );
  }

  function toggleAllComponents() {
    setSelectedComponentIds((prev) => (prev.length === components.length ? [] : components.map((c) => c.id)));
  }

  async function previewComponentsBulkSync() {
    setComponentsPreviewing(true);
    setComponentsError(null);
    try {
      const res = await api.previewComponentsBulkSync();
      setComponentsPreview(res);
    } catch (err) {
      setComponentsError(err.message);
    } finally {
      setComponentsPreviewing(false);
    }
  }

  function pollComponentsJob(jobId) {
    componentsPollRef.current = setInterval(async () => {
      try {
        const latest = await api.getComponentsBulkSyncJob(jobId);
        setComponentsJob(latest);
        if (latest.status !== "running") {
          clearInterval(componentsPollRef.current);
        }
      } catch (err) {
        clearInterval(componentsPollRef.current);
        setComponentsError(err.message);
      }
    }, POLL_INTERVAL_MS);
  }

  async function launchComponentsBulkSync() {
    setComponentsError(null);
    setComponentsJob(null);
    try {
      const res = await api.syncComponentsBulk();
      setComponentsJob({
        id: res.jobId,
        total: res.total,
        processed: 0,
        status: "running",
        results: [],
        wxrksProjectUUID: res.wxrksProjectUUID,
      });
      pollComponentsJob(res.jobId);
    } catch (err) {
      setComponentsError(err.message);
    }
  }

  async function cancelComponentsBulkSync() {
    if (!componentsJob) return;
    try {
      await api.cancelComponentsBulkSyncJob(componentsJob.id);
    } catch (err) {
      setComponentsError(err.message);
    }
  }

  async function doLaunchComponentsItemSync() {
    setComponentsItemPhase("running");
    setComponentsError(null);
    try {
      const res = await api.syncComponentsItem(selectedComponentIds);
      setComponentsResult(res);
      setComponentsItemPhase("done");
    } catch (err) {
      setComponentsError(err.message);
      setComponentsItemPhase("idle");
    }
  }

  function resetComponentsItemSync() {
    setComponentsItemPhase("idle");
    setComponentsResult(null);
    setSelectedComponentIds([]);
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
  const componentsTabs = [
    { value: "bulk", label: "Bulk Sync" },
    { value: "item", label: "Item Sync" },
  ];

  const orgUnitLabel = settings?.orgUnitUUID ? orgUnitName(settings.orgUnitUUID) : "not set";

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Translate</h1>
        <SegmentedControl
          options={[
            { value: "cms", label: "CMS Items" },
            { value: "pages", label: "Pages" },
            { value: "components", label: "Components" },
          ]}
          value={entityType}
          onChange={setEntityType}
        />
      </div>

      {entityType === "cms" && (
        <>
          <UnderlineTabs options={cmsTabs} value={mode} onChange={setMode} className="mb-5" />

          {mode === "bulk" && (
            <div className="flex items-start gap-5">
              <div className="min-w-0 flex-1">
                <Card className="p-4">
                  <label className="flex items-center gap-2 text-[13px] font-medium text-ink-soft">
                    Translate items updated since
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
                  <p className="mt-1 text-xs text-ink-faint">Leave blank to sync all items in all collections.</p>

                  {preview && (
                    <div className="mt-4 rounded-md border border-border bg-surface-sunken p-4 text-sm text-ink-soft">
                      {preview.totalItems === 0 ? (
                        <p>No items match this filter — nothing to sync.</p>
                      ) : (
                        <>
                          <p>
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
                        </>
                      )}
                    </div>
                  )}
                </Card>

                {job && (
                  <Card className="mt-4 p-4">
                    <div className="mb-2 flex items-center gap-3">
                      <StatusPill variant={job.status === "running" ? "progress" : job.status === "error" ? "error" : "success"} label={job.status} />
                      <span className="flex-1">
                        <ProgressBar value={job.processed} max={job.total} label={`${job.processed} / ${job.total} processed`} />
                      </span>
                    </div>
                    {job.status === "running" && (
                      <button
                        onClick={cancelBulkSync}
                        className="mt-2 rounded-md border border-status-error-fg/30 bg-surface px-3 py-1.5 text-sm font-medium text-status-error-fg hover:bg-status-error-bg"
                      >
                        Cancel
                      </button>
                    )}
                    {job.status !== "running" && job.results?.length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-medium text-ink-faint">Raw results</summary>
                        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-surface-sunken p-3 text-xs text-ink-soft">
                          {JSON.stringify(job.results, null, 2)}
                        </pre>
                      </details>
                    )}
                  </Card>
                )}
              </div>

              <SyncSidebar
                orgUnitName={orgUnitLabel}
                targetLocales={settings?.targetLocales}
                volumeLabel={preview ? `${preview.totalItems} items · ${preview.estimatedWordCount?.toLocaleString()}w` : "—"}
              >
                <button onClick={previewBulkSync} disabled={previewing || job?.status === "running"} className={btnGhost + " w-full justify-center"}>
                  {previewing ? "Checking..." : "Preview"}
                </button>
                <button
                  onClick={launchBulkSync}
                  disabled={!preview || preview.totalItems === 0 || job?.status === "running"}
                  className={btnPrimary + " w-full justify-center"}
                >
                  Launch — {preview?.totalItems ?? 0} items
                </button>
              </SyncSidebar>
            </div>
          )}

          {mode === "item" && (
            <>
              <div className="flex items-start gap-5">
                <div className="min-w-0 flex-1">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    {collections.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => setSelectedCollectionId(c.id)}
                        className={
                          "flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors " +
                          (selectedCollectionId === c.id
                            ? "border-ink bg-ink text-canvas"
                            : "border-border-strong bg-surface text-ink-soft hover:text-ink")
                        }
                      >
                        {c.displayName || c.singularName}
                        <span className="font-mono text-[11px] font-medium opacity-70 tabular-nums">
                          {backlogByCollection[c.id] ?? 0}
                        </span>
                      </button>
                    ))}
                    <span className="mx-1 h-5 w-px bg-border" />
                    {[
                      { value: "all", label: "All" },
                      { value: "needs", label: "Needs sync" },
                    ].map((f) => (
                      <button
                        key={f.value}
                        onClick={() => setItemFilter(f.value)}
                        className={
                          "rounded-md px-2.5 py-1 text-[12.5px] font-semibold " +
                          (itemFilter === f.value ? "bg-surface-sunken text-ink" : "text-ink-faint hover:text-ink-soft")
                        }
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>

                  <Card>
                    {items.length > 0 ? (
                      <div className="max-h-[28rem] overflow-auto">
                        <table className="w-full text-left text-sm">
                          <thead className="sticky top-0 z-10 bg-surface-sunken text-[10.5px] font-bold uppercase tracking-wide text-ink-faint">
                            <tr>
                              <th className="w-8 px-4 py-2">
                                <input type="checkbox" checked={selectedItemIds.length === visibleItems.length && visibleItems.length > 0} onChange={toggleAllItems} />
                              </th>
                              <th className="whitespace-nowrap px-3 py-2">Name</th>
                              <th className="whitespace-nowrap px-3 py-2 text-right">Words</th>
                              <th className="whitespace-nowrap px-3 py-2">Status</th>
                              {settings?.targetLocales.map((locale) => (
                                <th key={locale} className="whitespace-nowrap px-2 py-2 text-center">
                                  {locale.toUpperCase()}
                                </th>
                              ))}
                              <th className="whitespace-nowrap px-3 py-2 text-right">Published</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {visibleItems.map((item) => (
                              <tr key={item.id} className="hover:bg-surface-sunken">
                                <td className="px-4 py-2.5">
                                  <input type="checkbox" checked={selectedItemIds.includes(item.id)} onChange={() => toggleItem(item.id)} />
                                </td>
                                <td className="px-3 py-2.5 font-medium text-ink">{item.name}</td>
                                <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-ink-soft">
                                  {item.wordCount?.toLocaleString() ?? "—"}
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
                                  <td key={locale} className="px-2 py-2.5 text-center">
                                    <LocaleDot status={item.localeStatus?.[locale]} locale={locale} />
                                  </td>
                                ))}
                                <td className="px-3 py-2.5 text-right font-mono text-xs text-ink-faint">
                                  {formatDateOnly(item.lastPublished, settings?.timezone)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="p-4 text-sm text-ink-faint">
                        {selectedCollectionId ? "No items in this collection." : "Select a collection above."}
                      </p>
                    )}
                  </Card>
                </div>

                <SyncSidebar
                  orgUnitName={orgUnitLabel}
                  targetLocales={settings?.targetLocales}
                  volumeLabel={`${selectedItemIds.length} selected · ${selectedItemWords.toLocaleString()}w`}
                />
              </div>

              <SyncActionBar
                phase={itemPhase}
                entityLabel="item"
                selCount={selectedItemIds.length}
                selWords={selectedItemWords}
                targetCount={settings?.targetLocales.length || 0}
                onLaunch={() => setItemPhase("confirm")}
                onCancel={() => setItemPhase("idle")}
                onConfirm={doLaunchItemSync}
                onReset={resetItemSync}
                result={result}
              />
            </>
          )}

          {mode === "auto" && (
            <div className="flex items-start gap-5">
              <div className="min-w-0 flex-1">
                <Card className="p-5">
                  {!autoSyncStatus ? (
                    <p className="text-sm text-ink-soft">Loading status...</p>
                  ) : !autoSyncStatus.enabled ? (
                    <p className="text-sm text-ink-soft">
                      Auto Sync is disabled. Turn it on and configure which collections/conditions qualify in{" "}
                      <Link to="/templates" className="font-medium text-accent-text hover:underline">
                        Templates → Auto Sync
                      </Link>
                      .
                    </p>
                  ) : (
                    <>
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-ink">
                          Pending queue (<span className="font-mono tabular-nums">{autoSyncStatus.pendingCount}</span>)
                        </h3>
                      </div>
                      {flushError && <p className="mt-1 text-xs font-medium text-status-error-fg">{flushError}</p>}

                      {autoSyncStatus.pendingItems?.length > 0 ? (
                        <div className="mt-2 max-h-[28rem] overflow-auto rounded-md border border-border">
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
                      ) : (
                        <p className="mt-3 text-sm text-ink-faint">
                          Queue is empty. New and edited items will appear here as Webflow webhooks arrive.
                        </p>
                      )}
                    </>
                  )}
                </Card>
              </div>

              {autoSyncStatus?.enabled && (
                <div className="flex w-[19rem] flex-none flex-col gap-4">
                  <Card>
                    <div className="border-b border-border px-4 py-3 text-[13px] font-semibold text-ink">Next scheduled run</div>
                    <div className="flex flex-col gap-3 px-4 py-3.5">
                      <div>
                        <div className="font-mono text-[22px] font-semibold tabular-nums text-ink">
                          {autoSyncStatus.nextFlushAt ? formatDateTime(autoSyncStatus.nextFlushAt, autoSyncStatus.timezone) : "—"}
                        </div>
                        <div className="mt-0.5 text-xs text-ink-faint">
                          {autoSyncStatus.flushTimes?.join(", ")} ({autoSyncStatus.timezone})
                        </div>
                      </div>
                      <button onClick={flushAutoSyncNow} disabled={flushing || autoSyncStatus.pendingCount === 0} className={btnGhost + " w-full justify-center"}>
                        {flushing ? "Flushing..." : `Flush now — ${autoSyncStatus.pendingCount} items`}
                      </button>
                    </div>
                  </Card>
                  <Card>
                    <div className="border-b border-border px-4 py-3 text-[13px] font-semibold text-ink">Webhook health</div>
                    <div className="flex flex-col gap-2.5 px-4 py-3.5 text-[12.5px]">
                      {autoSyncStatus.webhookStatus === "active" ? (
                        <StatusPill variant="success" label="Active" />
                      ) : (
                        <StatusPill variant="error" label={autoSyncStatus.webhookStatus.replace("_", " ")} />
                      )}
                      {autoSyncStatus.webhookLastEventAt && (
                        <div className="flex justify-between">
                          <span className="text-ink-faint">Last event</span>
                          <span className="font-mono text-[11.5px] text-ink">
                            {formatDateTime(autoSyncStatus.webhookLastEventAt, autoSyncStatus.timezone)}
                          </span>
                        </div>
                      )}
                      {autoSyncStatus.webhookStatus !== "active" && (
                        <p className="text-status-progress-fg">
                          Not active — go to{" "}
                          <Link to="/templates" className="font-medium underline">
                            Templates → Auto Sync
                          </Link>{" "}
                          to re-register it.
                        </p>
                      )}
                    </div>
                  </Card>
                </div>
              )}
            </div>
          )}

          {error && <p className="mt-4 text-sm font-medium text-status-error-fg">Error: {error}</p>}
        </>
      )}

      {entityType === "pages" && (
        <>
          <UnderlineTabs options={pagesTabs} value={pagesMode} onChange={setPagesMode} className="mb-5" />

          {pagesMode === "bulk" && (
            <div className="flex items-start gap-5">
              <div className="min-w-0 flex-1">
                <Card className="p-4">
                  <p className="text-sm text-ink-soft">Syncs every enabled static page (see Templates → Pages).</p>
                  {pagesPreview && (
                    <div className="mt-4 rounded-md border border-border bg-surface-sunken p-4 text-sm text-ink-soft">
                      {pagesPreview.totalPages === 0 ? (
                        <p>No pages match the current filter — nothing to sync.</p>
                      ) : (
                        <p>
                          <b className="font-mono tabular-nums text-ink">{pagesPreview.totalPages}</b> page(s) · est.{" "}
                          <b className="font-mono tabular-nums text-ink">{pagesPreview.estimatedWordCount?.toLocaleString()}</b> words
                        </p>
                      )}
                    </div>
                  )}
                </Card>

                {pagesJob && (
                  <Card className="mt-4 p-4">
                    <div className="mb-2 flex items-center gap-3">
                      <StatusPill variant={pagesJob.status === "running" ? "progress" : pagesJob.status === "error" ? "error" : "success"} label={pagesJob.status} />
                      <span className="flex-1">
                        <ProgressBar value={pagesJob.processed} max={pagesJob.total} label={`${pagesJob.processed} / ${pagesJob.total} processed`} />
                      </span>
                    </div>
                    {pagesJob.status === "running" && (
                      <button onClick={cancelPagesBulkSync} className="mt-2 rounded-md border border-status-error-fg/30 bg-surface px-3 py-1.5 text-sm font-medium text-status-error-fg hover:bg-status-error-bg">
                        Cancel
                      </button>
                    )}
                    {pagesJob.status !== "running" && pagesJob.results?.length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-medium text-ink-faint">Raw results</summary>
                        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-surface-sunken p-3 text-xs text-ink-soft">
                          {JSON.stringify(pagesJob.results, null, 2)}
                        </pre>
                      </details>
                    )}
                  </Card>
                )}
              </div>

              <SyncSidebar
                orgUnitName={orgUnitLabel}
                targetLocales={settings?.targetLocales}
                volumeLabel={pagesPreview ? `${pagesPreview.totalPages} pages · ${pagesPreview.estimatedWordCount?.toLocaleString()}w` : "—"}
              >
                <button onClick={previewPagesBulkSync} disabled={pagesPreviewing || pagesJob?.status === "running"} className={btnGhost + " w-full justify-center"}>
                  {pagesPreviewing ? "Checking..." : "Preview"}
                </button>
                <button
                  onClick={launchPagesBulkSync}
                  disabled={!pagesPreview || pagesPreview.totalPages === 0 || pagesJob?.status === "running"}
                  className={btnPrimary + " w-full justify-center"}
                >
                  Launch — {pagesPreview?.totalPages ?? 0} pages
                </button>
              </SyncSidebar>
            </div>
          )}

          {pagesMode === "item" && (
            <>
              <div className="flex items-start gap-5">
                <div className="min-w-0 flex-1">
                  <Card>
                    {pages.length > 0 ? (
                      <div className="max-h-[28rem] overflow-auto">
                        <table className="w-full table-fixed text-left text-sm">
                          <thead className="sticky top-0 z-10 bg-surface-sunken text-[10.5px] font-bold uppercase tracking-wide text-ink-faint">
                            <tr>
                              <th className="w-8 px-4 py-2">
                                <input type="checkbox" checked={selectedPageIds.length === pages.length} onChange={toggleAllPages} />
                              </th>
                              <th className="w-[45%] px-3 py-2">Page</th>
                              <th className="w-[35%] px-3 py-2">Slug</th>
                              <th className="w-[20%] whitespace-nowrap px-3 py-2">Last updated</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {pages.map((page) => (
                              <tr key={page.id} className="hover:bg-surface-sunken">
                                <td className="px-4 py-2.5">
                                  <input type="checkbox" checked={selectedPageIds.includes(page.id)} onChange={() => togglePage(page.id)} />
                                </td>
                                <td className="truncate px-3 py-2.5 font-medium text-ink" title={page.title}>{page.title}</td>
                                <td className="truncate px-3 py-2.5 font-mono text-xs text-ink-faint" title={page.slug}>{page.slug}</td>
                                <td className="px-3 py-2.5 font-mono text-xs text-ink-faint">{formatDateOnly(page.lastUpdated, settings?.timezone)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="p-4 text-sm text-ink-faint">Loading pages...</p>
                    )}
                  </Card>
                </div>

                <SyncSidebar orgUnitName={orgUnitLabel} targetLocales={settings?.targetLocales} volumeLabel={`${selectedPageIds.length} selected`} />
              </div>

              <SyncActionBar
                phase={pagesItemPhase}
                entityLabel="page"
                selCount={selectedPageIds.length}
                selWords={0}
                targetCount={settings?.targetLocales.length || 0}
                onLaunch={() => setPagesItemPhase("confirm")}
                onCancel={() => setPagesItemPhase("idle")}
                onConfirm={doLaunchPagesItemSync}
                onReset={resetPagesItemSync}
                result={pagesResult}
              />
            </>
          )}

          {pagesError && <p className="mt-4 text-sm font-medium text-status-error-fg">Error: {pagesError}</p>}
        </>
      )}

      {entityType === "components" && (
        <>
          <UnderlineTabs options={componentsTabs} value={componentsMode} onChange={setComponentsMode} className="mb-5" />

          {componentsMode === "bulk" && (
            <div className="flex items-start gap-5">
              <div className="min-w-0 flex-1">
                <Card className="p-4">
                  <p className="text-sm text-ink-soft">
                    Syncs every enabled component's definition (see Templates → Components) — one translation, applies everywhere it's used.
                  </p>
                  {componentsPreview && (
                    <div className="mt-4 rounded-md border border-border bg-surface-sunken p-4 text-sm text-ink-soft">
                      {componentsPreview.totalComponents === 0 ? (
                        <p>No components match the current filter — nothing to sync.</p>
                      ) : (
                        <p>
                          <b className="font-mono tabular-nums text-ink">{componentsPreview.totalComponents}</b> component(s) · est.{" "}
                          <b className="font-mono tabular-nums text-ink">{componentsPreview.estimatedWordCount?.toLocaleString()}</b> words
                        </p>
                      )}
                    </div>
                  )}
                </Card>

                {componentsJob && (
                  <Card className="mt-4 p-4">
                    <div className="mb-2 flex items-center gap-3">
                      <StatusPill
                        variant={componentsJob.status === "running" ? "progress" : componentsJob.status === "error" ? "error" : "success"}
                        label={componentsJob.status}
                      />
                      <span className="flex-1">
                        <ProgressBar value={componentsJob.processed} max={componentsJob.total} label={`${componentsJob.processed} / ${componentsJob.total} processed`} />
                      </span>
                    </div>
                    {componentsJob.status === "running" && (
                      <button onClick={cancelComponentsBulkSync} className="mt-2 rounded-md border border-status-error-fg/30 bg-surface px-3 py-1.5 text-sm font-medium text-status-error-fg hover:bg-status-error-bg">
                        Cancel
                      </button>
                    )}
                    {componentsJob.status !== "running" && componentsJob.results?.length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-medium text-ink-faint">Raw results</summary>
                        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-surface-sunken p-3 text-xs text-ink-soft">
                          {JSON.stringify(componentsJob.results, null, 2)}
                        </pre>
                      </details>
                    )}
                  </Card>
                )}
              </div>

              <SyncSidebar
                orgUnitName={orgUnitLabel}
                targetLocales={settings?.targetLocales}
                volumeLabel={
                  componentsPreview ? `${componentsPreview.totalComponents} components · ${componentsPreview.estimatedWordCount?.toLocaleString()}w` : "—"
                }
              >
                <button onClick={previewComponentsBulkSync} disabled={componentsPreviewing || componentsJob?.status === "running"} className={btnGhost + " w-full justify-center"}>
                  {componentsPreviewing ? "Checking..." : "Preview"}
                </button>
                <button
                  onClick={launchComponentsBulkSync}
                  disabled={!componentsPreview || componentsPreview.totalComponents === 0 || componentsJob?.status === "running"}
                  className={btnPrimary + " w-full justify-center"}
                >
                  Launch — {componentsPreview?.totalComponents ?? 0} components
                </button>
              </SyncSidebar>
            </div>
          )}

          {componentsMode === "item" && (
            <>
              <div className="flex items-start gap-5">
                <div className="min-w-0 flex-1">
                  <Card>
                    {components.length > 0 ? (
                      <div className="max-h-[28rem] overflow-auto">
                        <table className="w-full table-fixed text-left text-sm">
                          <thead className="sticky top-0 z-10 bg-surface-sunken text-[10.5px] font-bold uppercase tracking-wide text-ink-faint">
                            <tr>
                              <th className="w-8 px-4 py-2">
                                <input type="checkbox" checked={selectedComponentIds.length === components.length} onChange={toggleAllComponents} />
                              </th>
                              <th className="w-[70%] px-3 py-2">Component</th>
                              <th className="w-[30%] px-3 py-2">Group</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {components.map((component) => (
                              <tr key={component.id} className="hover:bg-surface-sunken">
                                <td className="px-4 py-2.5">
                                  <input type="checkbox" checked={selectedComponentIds.includes(component.id)} onChange={() => toggleComponent(component.id)} />
                                </td>
                                <td className="truncate px-3 py-2.5 font-medium text-ink" title={component.name}>{component.name}</td>
                                <td className="truncate px-3 py-2.5 font-mono text-xs text-ink-faint">{component.group || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="p-4 text-sm text-ink-faint">Loading components...</p>
                    )}
                  </Card>
                </div>

                <SyncSidebar orgUnitName={orgUnitLabel} targetLocales={settings?.targetLocales} volumeLabel={`${selectedComponentIds.length} selected`} />
              </div>

              <SyncActionBar
                phase={componentsItemPhase}
                entityLabel="component"
                selCount={selectedComponentIds.length}
                selWords={0}
                targetCount={settings?.targetLocales.length || 0}
                onLaunch={() => setComponentsItemPhase("confirm")}
                onCancel={() => setComponentsItemPhase("idle")}
                onConfirm={doLaunchComponentsItemSync}
                onReset={resetComponentsItemSync}
                result={componentsResult}
              />
            </>
          )}

          {componentsError && <p className="mt-4 text-sm font-medium text-status-error-fg">Error: {componentsError}</p>}
        </>
      )}
    </div>
  );
}
