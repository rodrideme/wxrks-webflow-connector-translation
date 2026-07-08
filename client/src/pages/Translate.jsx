import { useEffect, useRef, useState } from "react";
import api from "../services/api.js";
import Card from "../components/Card.jsx";
import StatusPill from "../components/StatusPill.jsx";
import ContentBrowserRail from "../components/ContentBrowserRail.jsx";
import TranslateActionBar from "../components/TranslateActionBar.jsx";
import SendToWxrksModal from "../components/SendToWxrksModal.jsx";
import { itemMatchesFilters } from "../leafHelpers.js";
import { formatDateOnly } from "../formatDate.js";
import { localeStatusPill } from "../statusHelpers.jsx";

const NO_FOLDER_ID = "__root__";
const JOB_POLL_INTERVAL_MS = 1200;

const DOT_COLOR = {
  synced: "bg-status-success-dot border-status-success-dot",
  stale: "bg-status-progress-dot border-status-progress-dot",
  failed: "bg-status-error-dot border-status-error-dot",
  new: "bg-transparent border-border-strong",
};
function LocaleDot({ status, locale }) {
  const cls = DOT_COLOR[status] || DOT_COLOR.new;
  return <span title={`${locale.toUpperCase()} — ${status || "new"}`} className={`inline-block h-[9px] w-[9px] rounded-full border-[1.5px] ${cls}`} />;
}

const DATE_FILTER_OPTS = [
  { value: "", label: "Any time" },
  { value: "2026-05-01", label: "After 1 May 2026" },
  { value: "2026-06-01", label: "After 1 Jun 2026" },
  { value: "2026-07-01", label: "After 1 Jul 2026" },
];

export default function Translate() {
  const [mode, setMode] = useState("specific"); // "all" | "specific"
  const [settings, setSettings] = useState(null);

  const [collections, setCollections] = useState([]);
  const [pages, setPages] = useState([]);
  const [pageFolders, setPageFolders] = useState([]);
  const [components, setComponents] = useState([]);

  const [expandedGroups, setExpandedGroups] = useState({ collections: true, pages: true, components: true });
  const [activeLeaf, setActiveLeaf] = useState(null); // { kind, id, label }
  const [itemsByCollection, setItemsByCollection] = useState({});
  const [fieldsByCollection, setFieldsByCollection] = useState({});
  const [filtersByLeaf, setFiltersByLeaf] = useState({}); // leafKey -> Condition[]
  const [dateAfter, setDateAfter] = useState("");
  const [selected, setSelected] = useState({}); // `${kind}:${id}` -> true
  const [itemFilter, setItemFilter] = useState("all"); // all | needs | failed

  const [allItemsLoading, setAllItemsLoading] = useState(false);

  const [sendModalOpen, setSendModalOpen] = useState(false);
  const [phase, setPhase] = useState("idle"); // idle | running | done
  const [jobs, setJobs] = useState([]); // active background sync jobs being polled
  const jobsPollRef = useRef(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getSettings().then(setSettings);
    api.getCollections().then((res) => setCollections(res.collections || []));
    api.getPages().then((res) => setPages(res.pages || [])).catch((err) => setError(err.message));
    api.getPageFolders().then((res) => setPageFolders(res.folders || [])).catch(() => {});
    api.getComponents().then((res) => setComponents(res.components || [])).catch((err) => setError(err.message));
  }, []);

  function leafKeyOf(kind, id) {
    return `${kind}:${id}`;
  }

  async function loadCollectionItems(collectionId) {
    if (itemsByCollection[collectionId]) return itemsByCollection[collectionId];
    const res = await api.getCollectionItems(collectionId);
    setItemsByCollection((prev) => ({ ...prev, [collectionId]: res.items }));
    return res.items;
  }

  async function loadCollectionFields(collectionId) {
    if (fieldsByCollection[collectionId]) return;
    try {
      const res = await api.getCollectionFields(collectionId);
      setFieldsByCollection((prev) => ({ ...prev, [collectionId]: res.fields }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function openLeaf(kind, id, label) {
    setActiveLeaf({ kind, id, label });
    if (kind === "collection") {
      await loadCollectionItems(id);
      await loadCollectionFields(id);
    }
  }

  // Switching to "all" mode needs every collection's items loaded to
  // compute real aggregate stats (mirrors the old Bulk Sync dry-run's same
  // full enumeration -- an explicit, occasional action, not a hot path).
  useEffect(() => {
    if (mode !== "all" || collections.length === 0) return;
    const missing = collections.filter((c) => !itemsByCollection[c.id]);
    if (missing.length === 0) return;
    setAllItemsLoading(true);
    Promise.all(missing.map((c) => loadCollectionItems(c.id)))
      .catch((err) => setError(err.message))
      .finally(() => setAllItemsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, collections]);

  function itemsForLeaf(leaf) {
    if (!leaf) return [];
    if (leaf.kind === "collection") return itemsByCollection[leaf.id] || [];
    if (leaf.kind === "pagesFolder") return pages.filter((p) => (p.folderId || NO_FOLDER_ID) === leaf.id);
    return components;
  }

  function passesDateFilter(item) {
    if (!dateAfter) return true;
    const ts = new Date(dateAfter).getTime();
    const itemTs = new Date(item.lastPublished || item.lastUpdated || 0).getTime();
    return itemTs >= ts;
  }

  function matchingItemsForLeaf(leaf) {
    const key = leafKeyOf(leaf.kind, leaf.id);
    const filters = leaf.kind === "collection" ? filtersByLeaf[key] || [] : [];
    return itemsForLeaf(leaf)
      .filter(passesDateFilter)
      .filter((it) => itemMatchesFilters(it, filters));
  }

  // ---- Groups render data for the rail ----
  const collectionLeaves = collections.map((c) => {
    const leaf = { kind: "collection", id: c.id, label: c.displayName || c.singularName };
    return leaf;
  });
  const pagesFolderLeaves = [
    ...pageFolders.map((f) => ({ kind: "pagesFolder", id: f.id, label: f.title, count: f.pageCount })),
  ];
  const componentsLeaf = { kind: "components", id: "_", label: "Components", count: components.length };

  function leafCount(leaf) {
    if (leaf.kind === "pagesFolder") return leaf.count;
    if (leaf.kind === "components") return leaf.count;
    return itemsByCollection[leaf.id]?.length ?? "";
  }

  function isEntitySelected(kind, id) {
    return Boolean(selected[leafKeyOf(kind, id)]);
  }

  function toggleEntity(kind, id) {
    const key = leafKeyOf(kind, id);
    setSelected((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      return next;
    });
  }

  function leafSelectionMark(leaf) {
    const items = matchingItemsForLeaf(leaf);
    if (items.length === 0) return { mark: "", count: leafCount(leaf) };
    const selCount = items.filter((it) => isEntitySelected(leaf.kind, it.id)).length;
    if (selCount === 0) return { mark: "", count: leafCount(leaf) };
    if (selCount >= items.length) return { mark: "✓", count: leafCount(leaf) };
    return { mark: "–", count: leafCount(leaf) };
  }

  async function toggleWholeLeaf(leaf) {
    // Collections lazy-load their items on first open -- checking a leaf's
    // box directly from the rail (without opening it first) needs the same
    // fetch, or there's nothing yet to select. Use the freshly-fetched list
    // directly rather than re-reading state, which won't reflect this
    // fetch until the next render.
    let items;
    if (leaf.kind === "collection") {
      items = itemsByCollection[leaf.id] || (await loadCollectionItems(leaf.id));
      // A never-opened leaf has no filters set yet, so only the date
      // filter (if any) narrows it -- matches matchingItemsForLeaf's logic.
      items = items.filter(passesDateFilter);
    } else {
      items = itemsForLeaf(leaf).filter(passesDateFilter);
    }
    const allSelected = items.length > 0 && items.every((it) => isEntitySelected(leaf.kind, it.id));
    setSelected((prev) => {
      const next = { ...prev };
      items.forEach((it) => {
        const key = leafKeyOf(leaf.kind, it.id);
        if (allSelected) delete next[key];
        else next[key] = true;
      });
      return next;
    });
  }

  const groups = [
    {
      id: "collections",
      label: "Collections",
      count: collectionLeaves.length,
      expanded: expandedGroups.collections,
      onToggle: () => setExpandedGroups((p) => ({ ...p, collections: !p.collections })),
      leaves: collectionLeaves.map((lf) => {
        const key = leafKeyOf(lf.kind, lf.id);
        const { mark, count } = leafSelectionMark(lf);
        return {
          key,
          label: lf.label,
          count,
          mark,
          active: activeLeaf && activeLeaf.kind === lf.kind && activeLeaf.id === lf.id,
          filtered: (filtersByLeaf[key] || []).length > 0,
          onOpen: () => openLeaf(lf.kind, lf.id, lf.label),
          onCheck: () => toggleWholeLeaf(lf),
        };
      }),
    },
    {
      id: "pages",
      label: "Pages",
      count: pagesFolderLeaves.length,
      expanded: expandedGroups.pages,
      onToggle: () => setExpandedGroups((p) => ({ ...p, pages: !p.pages })),
      leaves: pagesFolderLeaves.map((lf) => {
        const key = leafKeyOf(lf.kind, lf.id);
        const { mark, count } = leafSelectionMark(lf);
        return {
          key,
          label: lf.label,
          count,
          mark,
          active: activeLeaf && activeLeaf.kind === lf.kind && activeLeaf.id === lf.id,
          filtered: false,
          onOpen: () => openLeaf(lf.kind, lf.id, lf.label),
          onCheck: () => toggleWholeLeaf(lf),
        };
      }),
    },
    {
      id: "components",
      label: "Components",
      count: 1,
      expanded: expandedGroups.components,
      onToggle: () => setExpandedGroups((p) => ({ ...p, components: !p.components })),
      leaves: [
        (() => {
          const key = leafKeyOf(componentsLeaf.kind, componentsLeaf.id);
          const { mark, count } = leafSelectionMark(componentsLeaf);
          return {
            key,
            label: componentsLeaf.label,
            count,
            mark,
            active: activeLeaf && activeLeaf.kind === "components",
            filtered: false,
            onOpen: () => openLeaf(componentsLeaf.kind, componentsLeaf.id, componentsLeaf.label),
            onCheck: () => toggleWholeLeaf(componentsLeaf),
          };
        })(),
      ],
    },
  ];

  // ---- Active leaf's item table ----
  const activeLeafKey = activeLeaf ? leafKeyOf(activeLeaf.kind, activeLeaf.id) : null;
  const activeFilters = activeLeaf?.kind === "collection" ? filtersByLeaf[activeLeafKey] || [] : [];
  const activeFields = activeLeaf?.kind === "collection" ? fieldsByCollection[activeLeaf.id] || [] : [];
  const activeMatching = activeLeaf ? matchingItemsForLeaf(activeLeaf) : [];
  const visibleItems = activeMatching.filter((it) => {
    if (itemFilter === "needs") return it.state !== "synced";
    if (itemFilter === "failed") return it.state === "failed";
    return true;
  });
  const allVisibleSelected = visibleItems.length > 0 && visibleItems.every((it) => isEntitySelected(activeLeaf?.kind, it.id));

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = { ...prev };
      visibleItems.forEach((it) => {
        const key = leafKeyOf(activeLeaf.kind, it.id);
        if (allVisibleSelected) delete next[key];
        else next[key] = true;
      });
      return next;
    });
  }

  function updateFilters(leaf, fn) {
    const key = leafKeyOf(leaf.kind, leaf.id);
    setFiltersByLeaf((prev) => ({ ...prev, [key]: fn(prev[key] || []) }));
  }

  function addFilter() {
    const fields = activeFields.filter((f) => ["DateTime", "Switch", "PlainText"].includes(f.type));
    if (fields.length === 0) return;
    const fd = fields[0];
    updateFilters(activeLeaf, (arr) => [
      ...arr,
      { fieldSlug: fd.slug, fieldType: fd.type, operator: "equals", value: fd.type === "Switch" ? true : "" },
    ]);
  }

  // ---- Selection summary (for bottom bar + send modal) ----
  function buildSelectionGroups() {
    const result = [];
    const allLeaves = [...collectionLeaves, ...pagesFolderLeaves, componentsLeaf];
    for (const leaf of allLeaves) {
      const items = itemsForLeaf(leaf);
      const selIds = items.filter((it) => isEntitySelected(leaf.kind, it.id)).map((it) => it.id);
      if (selIds.length === 0) continue;
      const key = leafKeyOf(leaf.kind, leaf.id);
      const filters = leaf.kind === "collection" ? filtersByLeaf[key] || [] : [];
      const words = items.filter((it) => selIds.includes(it.id)).reduce((sum, it) => sum + (it.wordCount || 0), 0);
      result.push({ kind: leaf.kind, leafId: leaf.id, label: leaf.label, ids: selIds, count: selIds.length, words, filters });
    }
    return result;
  }

  const selectionGroups = buildSelectionGroups();
  const selCount = selectionGroups.reduce((sum, g) => sum + g.count, 0);
  const selWords = selectionGroups.reduce((sum, g) => sum + g.words, 0);

  // Rule-based: every leaf with a selection must be either "whole leaf" or
  // "exactly the current filtered subset" -- never an arbitrary manual pick.
  const ruleBased =
    selectionGroups.length > 0 &&
    selectionGroups.every((g) => {
      const leaf = [...collectionLeaves, ...pagesFolderLeaves, componentsLeaf].find((l) => l.kind === g.kind && l.id === g.leafId);
      const matching = matchingItemsForLeaf(leaf).map((it) => it.id);
      return g.ids.length === matching.length && matching.every((id) => g.ids.includes(id));
    });

  const selection = { groups: selectionGroups, count: selCount, words: selWords };

  // ---- All-content summary ----
  const allGroups = [
    ...collections.map((c) => ({ kind: "collection", leafId: c.id, label: c.displayName || c.singularName, group: "Collections", ids: (itemsByCollection[c.id] || []).map((it) => it.id), words: (itemsByCollection[c.id] || []).reduce((s, it) => s + (it.wordCount || 0), 0) })),
    ...pageFolders.map((f) => ({ kind: "pagesFolder", leafId: f.id, label: f.title, group: "Pages", ids: pages.filter((p) => (p.folderId || NO_FOLDER_ID) === f.id).map((p) => p.id), words: 0 })),
    { kind: "components", leafId: "_", label: "Components", group: "Components", ids: components.map((c) => c.id), words: 0 },
  ];
  const allTotalItems = allGroups.reduce((s, g) => s + g.ids.length, 0);
  const allTotalWords = allGroups.reduce((s, g) => s + g.words, 0);
  const allSummary = { totalItems: allTotalItems, totalWords: allTotalWords, groups: allGroups };

  function resetAfterSend() {
    clearInterval(jobsPollRef.current);
    setPhase("idle");
    setJobs([]);
    setResult(null);
    setSelected({});
  }

  // One or more background sync jobs were just created (a selection can
  // span multiple kinds/leaves, each its own wxrks project/job) -- large
  // sends (a whole collection, "All content") can mean hundreds of real
  // wxrks API calls and take minutes, so this polls real progress instead
  // of a fire-and-forget spinner, matching the old Bulk Sync job UX.
  function handleJobsStarted(startedJobs) {
    setJobs(startedJobs.map((j) => ({ ...j, processed: 0, status: "running" })));
    setPhase("running");
    clearInterval(jobsPollRef.current);
    jobsPollRef.current = setInterval(async () => {
      try {
        const updated = await Promise.all(startedJobs.map((j) => api.getSyncJob(j.jobId)));
        setJobs(startedJobs.map((j, i) => ({ ...j, ...updated[i] })));
        const allDone = updated.every((j) => j.status !== "running");
        if (allDone) {
          clearInterval(jobsPollRef.current);
          const itemsSynced = updated.reduce((sum, j) => sum + j.results.filter((r) => !r.skipped && !r.error).length, 0);
          const errors = updated.reduce((sum, j) => sum + j.results.filter((r) => r.error).length, 0);
          setResult({
            itemsSynced,
            errors,
            wxrksProjectUUID: startedJobs[0]?.wxrksProjectUUID,
            wxrksProjectUUIDs: startedJobs.map((j) => j.wxrksProjectUUID),
          });
          setPhase("done");
        }
      } catch (err) {
        setError(err.message);
      }
    }, JOB_POLL_INTERVAL_MS);
  }

  async function cancelJobs() {
    clearInterval(jobsPollRef.current);
    try {
      await Promise.all(jobs.map((j) => api.cancelSyncJob(j.jobId)));
    } catch (err) {
      setError(err.message);
    }
    setPhase("idle");
    setJobs([]);
  }

  useEffect(() => () => clearInterval(jobsPollRef.current), []);

  const jobProgress =
    phase === "running"
      ? {
          processed: jobs.reduce((sum, j) => sum + (j.processed || 0), 0),
          total: jobs.reduce((sum, j) => sum + (j.total || 0), 0),
          jobCount: jobs.length,
        }
      : null;

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Translate</h1>
        <p className="mt-0.5 text-[13px] text-ink-faint">Send content to wxrks for translation, or automate it on a schedule.</p>
      </div>

      <div className="mb-4 flex gap-3">
        {[
          { value: "all", label: "All content", desc: "Translate the entire website" },
          { value: "specific", label: "Select specific content", desc: "Pick collections, pages or components and choose what to send" },
        ].map((m) => (
          <button
            key={m.value}
            onClick={() => setMode(m.value)}
            className={
              "flex max-w-[26rem] flex-1 items-start gap-2.5 rounded-lg border p-3.5 text-left " +
              (mode === m.value ? "border-accent bg-accent-subtle" : "border-border bg-surface")
            }
          >
            <span className={"mt-0.5 h-[15px] w-[15px] flex-none rounded-full border-[1.5px] shadow-[inset_0_0_0_2.5px_var(--surface)] " + (mode === m.value ? "border-accent bg-accent" : "border-border-strong")} />
            <div>
              <div className="text-[13.5px] font-semibold text-ink">{m.label}</div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-ink-faint">{m.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {mode === "specific" && (
        <div className="flex items-start gap-4">
          <ContentBrowserRail groups={groups} dateFilter={{ value: dateAfter, onChange: setDateAfter, options: DATE_FILTER_OPTS }} />

          <div className="min-w-0 flex-1">
            {!activeLeaf ? (
              <Card className="p-8 text-center text-sm text-ink-faint">Select a collection, page folder, or Components from the left.</Card>
            ) : (
              <>
                <div className="mb-2.5 flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-semibold text-ink">{activeLeaf.label}</span>
                  <span className="ml-auto font-mono text-[11.5px] text-ink-faint">{visibleItems.length} shown</span>
                </div>

                <div className="mb-3 flex flex-wrap items-center gap-2">
                  {[
                    { value: "all", label: "All" },
                    { value: "needs", label: "Needs sync" },
                    { value: "failed", label: "Failed" },
                  ].map((f) => (
                    <button
                      key={f.value}
                      onClick={() => setItemFilter(f.value)}
                      className={"rounded-md px-2.5 py-1 text-[12.5px] font-semibold " + (itemFilter === f.value ? "bg-surface-sunken text-ink" : "text-ink-faint hover:text-ink-soft")}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                {activeLeaf.kind === "collection" && (
                  <div className="mb-3 flex flex-col gap-2">
                    {activeFilters.map((f, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-[34px] text-[11.5px] font-semibold text-ink-faint">{i === 0 ? "Where" : "and"}</span>
                        <select
                          value={f.fieldSlug}
                          onChange={(e) => {
                            const fd = activeFields.find((x) => x.slug === e.target.value);
                            updateFilters(activeLeaf, (arr) => arr.map((c, j) => (j === i ? { fieldSlug: fd.slug, fieldType: fd.type, operator: "equals", value: fd.type === "Switch" ? true : "" } : c)));
                          }}
                          className="rounded-md border border-border-strong bg-surface px-2 py-1 text-xs"
                        >
                          {activeFields
                            .filter((fd) => ["DateTime", "Switch", "PlainText"].includes(fd.type))
                            .map((fd) => (
                              <option key={fd.slug} value={fd.slug}>
                                {fd.displayName}
                              </option>
                            ))}
                        </select>
                        {f.fieldType === "DateTime" ? (
                          <>
                            <select
                              value={f.operator}
                              onChange={(e) => updateFilters(activeLeaf, (arr) => arr.map((c, j) => (j === i ? { ...c, operator: e.target.value } : c)))}
                              className="rounded-md border border-border-strong bg-surface px-2 py-1 text-xs"
                            >
                              <option value="before">before</option>
                              <option value="after">after</option>
                              <option value="equals">equals</option>
                            </select>
                            <input
                              type="date"
                              value={f.value ? String(f.value).slice(0, 10) : ""}
                              onChange={(e) => updateFilters(activeLeaf, (arr) => arr.map((c, j) => (j === i ? { ...c, value: e.target.value } : c)))}
                              className="rounded-md border border-border-strong bg-surface px-2 py-1 text-xs"
                            />
                          </>
                        ) : f.fieldType === "Switch" ? (
                          <select
                            value={f.value ? "true" : "false"}
                            onChange={(e) => updateFilters(activeLeaf, (arr) => arr.map((c, j) => (j === i ? { ...c, value: e.target.value === "true" } : c)))}
                            className="rounded-md border border-border-strong bg-surface px-2 py-1 text-xs"
                          >
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={f.value || ""}
                            onChange={(e) => updateFilters(activeLeaf, (arr) => arr.map((c, j) => (j === i ? { ...c, value: e.target.value } : c)))}
                            placeholder="exact text"
                            className="rounded-md border border-border-strong bg-surface px-2 py-1 text-xs"
                          />
                        )}
                        <button onClick={() => updateFilters(activeLeaf, (arr) => arr.filter((_, j) => j !== i))} className="ml-auto text-ink-faint hover:text-status-error-fg">
                          ✕
                        </button>
                      </div>
                    ))}
                    <button onClick={addFilter} className="self-start rounded-md border border-dashed border-border-strong px-2.5 py-1 text-xs font-semibold text-accent-text">
                      + Add filter
                    </button>
                  </div>
                )}

                <Card>
                  {visibleItems.length > 0 ? (
                    <div className="max-h-[28rem] overflow-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="sticky top-0 z-10 bg-surface-sunken text-[10.5px] font-bold uppercase tracking-wide text-ink-faint">
                          <tr>
                            <th className="w-8 px-4 py-2">
                              <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
                            </th>
                            <th className="px-3 py-2">Name</th>
                            {activeLeaf.kind === "collection" && <th className="px-3 py-2 text-right">Words</th>}
                            <th className="px-3 py-2">Status</th>
                            {settings?.targetLocales.map((locale) => (
                              <th key={locale} className="px-2 py-2 text-center">
                                {locale.toUpperCase()}
                              </th>
                            ))}
                            <th className="px-3 py-2 text-right">Last update</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {visibleItems.map((item) => (
                            <tr key={item.id} className="hover:bg-surface-sunken">
                              <td className="px-4 py-2.5">
                                <input type="checkbox" checked={isEntitySelected(activeLeaf.kind, item.id)} onChange={() => toggleEntity(activeLeaf.kind, item.id)} />
                              </td>
                              <td className="px-3 py-2.5">
                                <div className="font-medium text-ink">{item.name || item.title}</div>
                                {item.state === "failed" && (
                                  <div className="mt-0.5 text-[11px] text-status-error-fg">
                                    {Object.values(item.localeErrors || {})[0] || "Push failed"}
                                  </div>
                                )}
                              </td>
                              {activeLeaf.kind === "collection" && (
                                <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-ink-soft">{item.wordCount?.toLocaleString() ?? "—"}</td>
                              )}
                              <td className="px-3 py-2.5">{localeStatusPill(item.state)}</td>
                              {settings?.targetLocales.map((locale) => (
                                <td key={locale} className="px-2 py-2.5 text-center">
                                  <LocaleDot status={item.localeStatus?.[locale]} locale={locale} />
                                </td>
                              ))}
                              <td className="px-3 py-2.5 text-right font-mono text-xs text-ink-faint">{formatDateOnly(item.lastPublished || item.lastUpdated, settings?.timezone)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : activeLeaf.kind === "collection" && !itemsByCollection[activeLeaf.id] ? (
                    <p className="p-4 text-sm text-ink-faint">Loading…</p>
                  ) : (
                    <p className="p-4 text-sm text-ink-faint">No items{itemFilter !== "all" ? " match this filter" : ""}.</p>
                  )}
                </Card>
              </>
            )}
          </div>
        </div>
      )}

      {mode === "all" && (
        <Card>
          {allItemsLoading ? (
            <p className="p-4 text-sm text-ink-faint">Computing totals…</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-sunken text-[10.5px] font-bold uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-2">Source</th>
                  <th className="px-4 py-2 text-right">Words</th>
                  <th className="px-4 py-2 text-right">Items</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {allGroups.map((g) => (
                  <tr key={`${g.kind}:${g.leafId}`}>
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-ink">{g.label}</span> <span className="font-mono text-xs text-ink-faint">{g.group}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-ink-soft">{g.words > 0 ? g.words.toLocaleString() : "—"}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-ink">{g.ids.length}</td>
                  </tr>
                ))}
                <tr className="bg-surface-sunken font-semibold">
                  <td className="px-4 py-2.5">Total</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums">{allTotalWords.toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums">{allTotalItems}</td>
                </tr>
              </tbody>
            </table>
          )}
        </Card>
      )}

      {error && <p className="mt-4 text-sm font-medium text-status-error-fg">Error: {error}</p>}

      <TranslateActionBar
        mode={mode}
        selCount={selCount}
        selWords={selWords}
        targetCount={settings?.targetLocales.length || 0}
        ruleBased={ruleBased}
        allTotalItems={allTotalItems}
        allTotalWords={allTotalWords}
        phase={phase}
        progress={jobProgress}
        result={result}
        onOpenSend={() => setSendModalOpen(true)}
        onReset={resetAfterSend}
        onCancel={cancelJobs}
      />

      <SendToWxrksModal
        open={sendModalOpen}
        onClose={() => setSendModalOpen(false)}
        scope={mode}
        selection={selection}
        allSummary={allSummary}
        ruleBased={ruleBased}
        onJobsStarted={handleJobsStarted}
        onRecurringCreated={() => {
          setError(null);
        }}
      />
    </div>
  );
}
