import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api from "../services/api.js";
import Card from "../components/Card.jsx";
import StatusPill from "../components/StatusPill.jsx";
import ContentBrowserRail from "../components/ContentBrowserRail.jsx";
import ReferenceFilterValue from "../components/ReferenceFilterValue.jsx";
import LoadingState from "../components/LoadingState.jsx";
import TranslateActionBar from "../components/TranslateActionBar.jsx";
import SendToWxrksModal from "../components/SendToWxrksModal.jsx";
import { itemMatchesFilters } from "../leafHelpers.js";
import { formatDateOnly } from "../formatDate.js";
import { localeStatusPill } from "../statusHelpers.jsx";

const NO_FOLDER_ID = "__root__";
const JOB_POLL_INTERVAL_MS = 1200;

const DATE_FILTER_OPTS = [
  { value: "", label: "Any time" },
  { value: "2026-05-01", label: "After 1 May 2026" },
  { value: "2026-06-01", label: "After 1 Jun 2026" },
  { value: "2026-07-01", label: "After 1 Jul 2026" },
];

const FILTERABLE_FIELD_TYPES = ["DateTime", "Switch", "PlainText", "Reference", "MultiReference"];

// Reference/MultiReference default to an empty picked-options array (matches
// nothing until the user actually picks something), same "must actively
// choose a value" behavior the other field types already default to.
function defaultFilterValue(fieldType) {
  if (fieldType === "Switch") return true;
  if (fieldType === "Reference" || fieldType === "MultiReference") return [];
  return "";
}

export default function Translate() {
  const [mode, setMode] = useState("all"); // "all" | "specific"
  const [settings, setSettings] = useState(null);

  const [collections, setCollections] = useState([]);
  const [pages, setPages] = useState([]);
  const [pageFolders, setPageFolders] = useState([]);
  const [components, setComponents] = useState([]);

  const [expandedGroups, setExpandedGroups] = useState({ collections: true, pages: true, components: true });
  const [activeLeaf, setActiveLeaf] = useState(null); // { kind, id, label }
  const [itemsByCollection, setItemsByCollection] = useState({});
  const [collectionLoadErrors, setCollectionLoadErrors] = useState({}); // collectionId -> error message, after retries exhausted
  // Separate, lighter-weight state for the "All content" aggregate -- see
  // loadCollectionSummary below for why this can't just reuse
  // itemsByCollection.
  const [collectionSummaries, setCollectionSummaries] = useState({}); // collectionId -> [{id, wordCount}]
  const [collectionSummaryErrors, setCollectionSummaryErrors] = useState({});
  const [itemsLoadedByCollection, setItemsLoadedByCollection] = useState({}); // collectionId -> running item count, progress display only
  const [fieldsByCollection, setFieldsByCollection] = useState({});
  const [filtersByLeaf, setFiltersByLeaf] = useState({}); // leafKey -> Condition[]
  const [dateAfter, setDateAfter] = useState("");
  const [selected, setSelected] = useState({}); // `${kind}:${id}` -> true
  const [itemFilter, setItemFilter] = useState("all"); // all | needs | failed

  // Starts true (rather than false + flip-on-effect) so the very first
  // render -- before the mount effect below has even resolved once -- shows
  // the loading state instead of a table built from still-empty collections/
  // pages/components arrays. initialDataLoaded gates both this and the
  // per-leaf loading check for non-collection leaves (Pages/Components,
  // which load once up front rather than lazily per leaf).
  const [allItemsLoading, setAllItemsLoading] = useState(true);
  const [initialDataLoaded, setInitialDataLoaded] = useState(false);

  const [sendModalOpen, setSendModalOpen] = useState(false);
  const [phase, setPhase] = useState("idle"); // idle | running | done
  const [jobs, setJobs] = useState([]); // active background sync jobs being polled
  const jobsPollRef = useRef(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Deep-link support for Dashboard's "Sync entire website" card
  // (/translate?autoSend=1) -- waits for the same "counting done" gate the
  // real "Translate all" button uses, then opens the modal itself and
  // strips the param so a refresh/back-nav doesn't reopen it.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get("autoSend") && !allItemsLoading) {
      setSendModalOpen(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, allItemsLoading]);

  useEffect(() => {
    api.getSettings().then(setSettings);
    // allSettled (not all + per-call .catch) so the final `error` reflects
    // whether any call is STILL failing once every one of them has
    // finished, rather than whichever settled last -- with independent
    // per-call .catch(setError), a later success could silently clear a
    // real failure from an earlier call, or a same-tick unrelated success
    // could race a failure and leave a stale error banner up even though
    // every call that matters actually succeeded (confirmed live: this is
    // what caused the Translate page's transient "Request failed with
    // status code 403" banner to linger despite content loading fine).
    // getPageFolders is intentionally excluded -- its own failure has
    // never been surfaced as an error (non-critical, folders just don't
    // group).
    Promise.allSettled([
      api.getCollections().then((res) => setCollections(res.collections || [])),
      api.getPages().then((res) => setPages(res.pages || [])),
      api.getPageFolders().then((res) => setPageFolders(res.folders || [])).catch(() => {}),
      api.getComponents().then((res) => setComponents(res.components || [])),
    ]).then(([collectionsResult, pagesResult, , componentsResult]) => {
      // Labeled so a persistent (not transient) failure -- e.g. a stale
      // OAuth token whose scope predates a later expansion, which fails
      // the same way on every retry -- at least says WHICH of the three
      // calls it is, instead of a bare, unhelpful "Request failed with
      // status code 403".
      const labeled = [
        { label: "Collections", result: collectionsResult },
        { label: "Pages", result: pagesResult },
        { label: "Components", result: componentsResult },
      ];
      const failed = labeled.find((l) => l.result.status === "rejected");
      setError(failed ? `${failed.label}: ${failed.result.reason.message}` : null);
    }).finally(() => setInitialDataLoaded(true));
  }, []);

  function leafKeyOf(kind, id) {
    return `${kind}:${id}`;
  }

  // Retries scoped to just this one collection's request -- unlike the
  // interceptor-level retry tried (and reverted) earlier, this can't
  // amplify the "All content" aggregate's total latency, since only the
  // specific collection that hit a transient error pays the extra delay,
  // not every one of the ~100+ requests the aggregate fires at once.
  async function loadCollectionItems(collectionId, attempt = 1) {
    if (itemsByCollection[collectionId]) return itemsByCollection[collectionId];
    try {
      const res = await api.getCollectionItems(collectionId);
      setItemsByCollection((prev) => ({ ...prev, [collectionId]: res.items }));
      setCollectionLoadErrors((prev) => {
        if (!(collectionId in prev)) return prev;
        const next = { ...prev };
        delete next[collectionId];
        return next;
      });
      return res.items;
    } catch (err) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1200 * attempt));
        return loadCollectionItems(collectionId, attempt + 1);
      }
      setCollectionLoadErrors((prev) => ({ ...prev, [collectionId]: err.message }));
      throw err;
    }
  }

  // Lighter-weight sibling of loadCollectionItems, used only by "All
  // content" mode's aggregate below -- fetches GET /items-summary (source
  // locale + word counts only, no per-target-locale fetches) instead of
  // the full per-item-per-locale endpoint, since the aggregate never
  // needs locale delivery status. Kept as separate state from
  // itemsByCollection so opening a specific collection's detail view
  // (which DOES need the full per-locale data) always does its own real
  // fetch rather than mistaking a summary-only load for "already loaded".
  // Paginates itself (rather than one server-side call that blocks until
  // the whole collection is fetched) so a single large collection's
  // progress shows up incrementally via itemsLoadedByCollection -- without
  // this, the "N of M collections" counter looked frozen at whatever
  // smaller collections had already finished while one big collection
  // silently loaded page by page in the background with no visible
  // movement at all. collectionSummaries itself is only ever set once, on
  // full completion -- it's the "is this collection done" source of
  // truth, so a retry after a mid-pagination failure can't mistake a
  // partial result for a finished one.
  async function loadCollectionSummary(collectionId, attempt = 1) {
    if (collectionSummaries[collectionId]) return collectionSummaries[collectionId];
    try {
      let offset = 0;
      let accumulated = [];
      let total = Infinity;
      while (accumulated.length < total) {
        const res = await api.getCollectionItemsSummary(collectionId, offset);
        accumulated = accumulated.concat(res.items);
        total = res.total;
        offset += res.items.length;
        setItemsLoadedByCollection((prev) => ({ ...prev, [collectionId]: accumulated.length }));
        if (res.items.length === 0) break; // safety against an infinite loop on a malformed response
      }
      setCollectionSummaries((prev) => ({ ...prev, [collectionId]: accumulated }));
      setCollectionSummaryErrors((prev) => {
        if (!(collectionId in prev)) return prev;
        const next = { ...prev };
        delete next[collectionId];
        return next;
      });
      return accumulated;
    } catch (err) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1200 * attempt));
        return loadCollectionSummary(collectionId, attempt + 1);
      }
      setCollectionSummaryErrors((prev) => ({ ...prev, [collectionId]: err.message }));
      throw err;
    }
  }

  async function loadCollectionFields(collectionId) {
    if (fieldsByCollection[collectionId]) return fieldsByCollection[collectionId];
    try {
      const res = await api.getCollectionFields(collectionId);
      setFieldsByCollection((prev) => ({ ...prev, [collectionId]: res.fields }));
      return res.fields;
    } catch (err) {
      setError(err.message);
      return [];
    }
  }

  async function openLeaf(kind, id, label) {
    setActiveLeaf({ kind, id, label });
    if (kind === "collection") {
      try {
        await loadCollectionItems(id);
      } catch {
        return; // recorded in collectionLoadErrors; rendered below with a retry action
      }
      const fields = await loadCollectionFields(id);
      // A filter saved against this leaf earlier (or loaded from a saved
      // automation) may already reference a linked collection -- make sure
      // its real option names are ready before the filter row renders,
      // rather than only fetching them the moment the user picks the field
      // fresh (see the field-picker's onChange and addFilter below).
      const existingFilters = filtersByLeaf[leafKeyOf(kind, id)] || [];
      for (const f of existingFilters) {
        if (f.fieldType !== "Reference" && f.fieldType !== "MultiReference") continue;
        const fd = fields.find((x) => x.slug === f.fieldSlug);
        if (fd?.linkedCollectionId) loadCollectionItems(fd.linkedCollectionId).catch(() => {});
      }
    }
  }

  // Every collection's summary (id + word count) is loaded eagerly,
  // regardless of mode -- "All content" needs it for its aggregate totals,
  // and "Select specific content" needs it so the rail shows every
  // collection/folder/component's real item count up front instead of a
  // collection only getting a count once the user clicks it open (mirrors
  // the old Bulk Sync dry-run's same full enumeration -- an explicit,
  // occasional action, not a hot path). allSettled (not all) so one
  // collection's transient failure doesn't wipe out the whole page with an
  // error while every other collection's totals loaded fine; that
  // collection's own error is tracked in collectionSummaryErrors instead
  // (see loadCollectionSummary's per-collection retry above).
  useEffect(() => {
    if (!initialDataLoaded) return;
    const missing = collections.filter((c) => !collectionSummaries[c.id] && !collectionSummaryErrors[c.id]);
    if (missing.length === 0) {
      setAllItemsLoading(false);
      return;
    }
    setAllItemsLoading(true);
    Promise.allSettled(missing.map((c) => loadCollectionSummary(c.id))).finally(() => setAllItemsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collections, initialDataLoaded]);

  const collectionsDoneCount = collections.filter((c) => collectionSummaries[c.id] || collectionSummaryErrors[c.id]).length;
  const failedCollectionIds = Object.keys(collectionSummaryErrors);
  // Sums itemsLoadedByCollection (updated on every page, mid-pagination)
  // rather than collectionSummaries (only set once a collection fully
  // finishes) -- so this keeps climbing even while one large collection
  // is still loading, instead of looking frozen at whatever smaller
  // collections had already completed.
  const itemsCountedSoFar = Object.values(itemsLoadedByCollection).reduce((s, n) => s + n, 0);

  function retryFailedCollections() {
    if (failedCollectionIds.length === 0) return;
    setCollectionSummaryErrors({});
    setAllItemsLoading(true);
    Promise.allSettled(failedCollectionIds.map((id) => loadCollectionSummary(id))).finally(() => setAllItemsLoading(false));
  }

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
    // itemsByCollection (full per-item data) only exists once the leaf's
    // been opened; collectionSummaries (id + word count only) is loaded
    // eagerly for every collection up front, so it's there from the very
    // first render of the rail.
    return itemsByCollection[leaf.id]?.length ?? collectionSummaries[leaf.id]?.length ?? "";
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

  // Changing a leaf's filters must never silently turn a rule-based pick
  // into an "individual selection" -- if the leaf's current selection
  // exactly matches its OLD filtered set (whole leaf, or a prior filter's
  // matches), resync it to the NEW filtered set so it stays rule-based.
  // A genuine manual partial pick (some items unchecked by hand) is left
  // untouched -- that's the one case that should stay "individual".
  function updateFilters(leaf, fn) {
    const key = leafKeyOf(leaf.kind, leaf.id);
    const oldFilters = filtersByLeaf[key] || [];
    const items = itemsForLeaf(leaf).filter(passesDateFilter);
    const oldMatchingIds = items.filter((it) => itemMatchesFilters(it, oldFilters)).map((it) => it.id);
    const selectedIds = items.filter((it) => isEntitySelected(leaf.kind, it.id)).map((it) => it.id);
    const wasRuleBased = oldMatchingIds.length > 0 && selectedIds.length === oldMatchingIds.length && oldMatchingIds.every((id) => selectedIds.includes(id));

    const nextFilters = fn(oldFilters);
    setFiltersByLeaf((prev) => ({ ...prev, [key]: nextFilters }));

    if (wasRuleBased) {
      const newMatchingIds = new Set(items.filter((it) => itemMatchesFilters(it, nextFilters)).map((it) => it.id));
      setSelected((prevSel) => {
        const nextSel = { ...prevSel };
        items.forEach((it) => {
          const k = leafKeyOf(leaf.kind, it.id);
          if (newMatchingIds.has(it.id)) nextSel[k] = true;
          else delete nextSel[k];
        });
        return nextSel;
      });
    }
  }

  function addFilter() {
    const fields = activeFields.filter((f) => FILTERABLE_FIELD_TYPES.includes(f.type));
    if (fields.length === 0) return;
    const fd = fields[0];
    if (fd.linkedCollectionId) loadCollectionItems(fd.linkedCollectionId).catch(() => {});
    updateFilters(activeLeaf, (arr) => [
      ...arr,
      { fieldSlug: fd.slug, fieldType: fd.type, operator: "equals", value: defaultFilterValue(fd.type) },
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
  // Only meaningful for "specific" mode's own selection state -- "all"
  // mode is always trivially a rule ({scope: "all"}), regardless of
  // whatever was previously selected in "specific" mode (that state simply
  // isn't cleared on switching modes, since a user flipping back to
  // "specific" should still see their prior picks -- it just must not leak
  // into "all" mode's own recurring-eligibility check, which used to
  // happen here since this ran unconditionally).
  const ruleBased =
    mode === "all" ||
    (selectionGroups.length > 0 &&
      selectionGroups.every((g) => {
        const leaf = [...collectionLeaves, ...pagesFolderLeaves, componentsLeaf].find((l) => l.kind === g.kind && l.id === g.leafId);
        const matching = matchingItemsForLeaf(leaf).map((it) => it.id);
        return g.ids.length === matching.length && matching.every((id) => g.ids.includes(id));
      }));

  const selection = { groups: selectionGroups, count: selCount, words: selWords };

  // ---- All-content summary ----
  const allGroups = [
    ...collections.map((c) => ({ kind: "collection", leafId: c.id, label: c.displayName || c.singularName, group: "Collections", ids: (collectionSummaries[c.id] || []).map((it) => it.id), words: (collectionSummaries[c.id] || []).reduce((s, it) => s + (it.wordCount || 0), 0) })),
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
            // From the freshly-polled jobs, not the startedJobs closure --
            // an automation's first-run job doesn't know its wxrksProjectUUID
            // until the background flush creates the project, well after
            // this poller started (unlike a one-time send, which already
            // knows it at job-start time).
            wxrksProjectUUID: updated[0]?.wxrksProjectUUID,
            wxrksProjectUUIDs: updated.map((j) => j.wxrksProjectUUID),
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
          // True while an automation's first-run job is still scanning
          // (see automationScheduler.js's startFirstSyncJob) -- total/
          // processed aren't real counts yet at that point.
          scanning: jobs.some((j) => j.scanning),
        }
      : null;

  return (
    <div className="flex min-h-full flex-col">
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

      {mode === "specific" && allItemsLoading && (
        <Card>
          <LoadingState
            label={
              collections.length > 0
                ? `${itemsCountedSoFar.toLocaleString()} items counted — ${collectionsDoneCount} of ${collections.length} collections done`
                : "Computing totals across your site"
            }
          />
        </Card>
      )}

      {mode === "specific" && !allItemsLoading && (
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
                    {activeFilters.map((f, i) => {
                      const fd = activeFields.find((x) => x.slug === f.fieldSlug);
                      return (
                      <div key={i} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-[34px] text-[11.5px] font-semibold text-ink-faint">{i === 0 ? "Where" : "and"}</span>
                        <select
                          value={f.fieldSlug}
                          onChange={(e) => {
                            const newFd = activeFields.find((x) => x.slug === e.target.value);
                            if (newFd.linkedCollectionId) loadCollectionItems(newFd.linkedCollectionId).catch(() => {});
                            updateFilters(activeLeaf, (arr) => arr.map((c, j) => (j === i ? { fieldSlug: newFd.slug, fieldType: newFd.type, operator: "equals", value: defaultFilterValue(newFd.type) } : c)));
                          }}
                          className="rounded-md border border-border-strong bg-surface px-2 py-1 text-xs"
                        >
                          {activeFields
                            .filter((x) => FILTERABLE_FIELD_TYPES.includes(x.type))
                            .map((x) => (
                              <option key={x.slug} value={x.slug}>
                                {x.displayName}
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
                        ) : f.fieldType === "Reference" || f.fieldType === "MultiReference" ? (
                          <>
                            <select
                              value={f.operator}
                              onChange={(e) => updateFilters(activeLeaf, (arr) => arr.map((c, j) => (j === i ? { ...c, operator: e.target.value } : c)))}
                              className="rounded-md border border-border-strong bg-surface px-2 py-1 text-xs"
                            >
                              <option value="equals">is</option>
                              <option value="notEquals">is not</option>
                            </select>
                            <ReferenceFilterValue
                              options={itemsByCollection[fd?.linkedCollectionId] || []}
                              loading={Boolean(fd?.linkedCollectionId) && !itemsByCollection[fd.linkedCollectionId] && !collectionLoadErrors[fd.linkedCollectionId]}
                              error={fd?.linkedCollectionId ? collectionLoadErrors[fd.linkedCollectionId] : null}
                              onRetry={() => fd?.linkedCollectionId && loadCollectionItems(fd.linkedCollectionId).catch(() => {})}
                              selectedIds={f.value || []}
                              onChange={(ids) => updateFilters(activeLeaf, (arr) => arr.map((c, j) => (j === i ? { ...c, value: ids } : c)))}
                            />
                          </>
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
                      );
                    })}
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
                            <th className="px-3 py-2">
                              <span className="group relative inline-flex cursor-help items-center gap-1">
                                Status
                                <span className="text-[11px] normal-case text-ink-faint">ⓘ</span>
                                <span className="invisible absolute left-0 top-full z-20 mt-1.5 w-64 rounded-md border border-border bg-surface p-2.5 text-[11px] font-normal normal-case leading-snug tracking-normal text-ink-soft opacity-0 shadow-card transition-opacity group-hover:visible group-hover:opacity-100">
                                  <strong className="text-ink">New</strong> = never sent &middot; <strong className="text-ink">Synced</strong> = up to date &middot;{" "}
                                  <strong className="text-ink">Stale</strong> = source changed since last send &middot; <strong className="text-ink">Failed</strong> = last attempt errored.{" "}
                                  <a
                                    href="/docs/translating-content.html#sync-status"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="font-medium text-accent-text hover:underline"
                                  >
                                    Learn more →
                                  </a>
                                </span>
                              </span>
                            </th>
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
                              <td className="px-3 py-2.5 text-right font-mono text-xs text-ink-faint">{formatDateOnly(item.lastPublished || item.lastUpdated, settings?.timezone)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : activeLeaf.kind === "collection" && collectionLoadErrors[activeLeaf.id] ? (
                    <div className="flex flex-col items-center gap-2 p-8 text-center">
                      <p className="text-sm text-status-error-fg">Couldn't load {activeLeaf.label}: {collectionLoadErrors[activeLeaf.id]}</p>
                      <button
                        type="button"
                        onClick={() => loadCollectionItems(activeLeaf.id).then(() => loadCollectionFields(activeLeaf.id)).catch(() => {})}
                        className="text-sm font-semibold text-accent-text hover:underline"
                      >
                        Retry
                      </button>
                    </div>
                  ) : activeLeaf.kind === "collection" && !itemsByCollection[activeLeaf.id] ? (
                    <LoadingState label={`Loading ${activeLeaf.label}`} />
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
            <LoadingState
              label={
                collections.length > 0
                  ? `${itemsCountedSoFar.toLocaleString()} items counted — ${collectionsDoneCount} of ${collections.length} collections done`
                  : "Computing totals across your site"
              }
            />
          ) : (
            <>
              {failedCollectionIds.length > 0 && (
                <div className="flex items-center justify-between gap-3 border-b border-border bg-status-error-bg px-4 py-2.5 text-[12.5px] text-status-error-fg">
                  <span>
                    {failedCollectionIds.length} collection{failedCollectionIds.length > 1 ? "s" : ""} couldn't be loaded
                    (temporary error) — totals below don't include{" "}
                    {failedCollectionIds.length > 1 ? "them" : "it"}.
                  </span>
                  <button type="button" onClick={retryFailedCollections} className="font-semibold underline hover:no-underline">
                    Retry
                  </button>
                </div>
              )}
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
            </>
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
        allItemsLoading={allItemsLoading}
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
