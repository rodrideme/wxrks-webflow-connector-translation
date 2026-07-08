import { useEffect, useState } from "react";
import api from "../services/api.js";
import StatusPill from "../components/StatusPill.jsx";
import Card from "../components/Card.jsx";
import SegmentedControl from "../components/SegmentedControl.jsx";
import SyncSidebar from "../components/SyncSidebar.jsx";
import ItemSyncAction from "../components/ItemSyncAction.jsx";
import { formatDateOnly } from "../formatDate.js";

// Per-locale status as a compact dot (CMS item table only -- Pages/
// Components don't have this data without an expensive per-row fetch).
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

export default function SelectAndSend() {
  const [entityType, setEntityType] = useState("cms");

  const [collections, setCollections] = useState([]);
  const [backlog, setBacklog] = useState([]);
  const [orgUnits, setOrgUnits] = useState([]);
  const [settings, setSettings] = useState(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [items, setItems] = useState([]);
  const [itemFilter, setItemFilter] = useState("all");
  const [selectedItemIds, setSelectedItemIds] = useState([]);

  const [itemPhase, setItemPhase] = useState("idle"); // idle | confirm | running | done
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Pages
  const [pages, setPages] = useState([]);
  const [selectedPageIds, setSelectedPageIds] = useState([]);
  const [pagesItemPhase, setPagesItemPhase] = useState("idle");
  const [pagesResult, setPagesResult] = useState(null);
  const [pagesError, setPagesError] = useState(null);

  // Components
  const [components, setComponents] = useState([]);
  const [selectedComponentIds, setSelectedComponentIds] = useState([]);
  const [componentsItemPhase, setComponentsItemPhase] = useState("idle");
  const [componentsResult, setComponentsResult] = useState(null);
  const [componentsError, setComponentsError] = useState(null);

  useEffect(() => {
    api.getCollections().then((res) => setCollections(res.collections || []));
    api.getBacklog().then((res) => setBacklog(res.backlog || [])).catch(() => {});
    api.getOrgUnits().then((res) => setOrgUnits(res.orgUnits || [])).catch(() => {});
    api.getSettings().then(setSettings);
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
    if (entityType !== "pages" || pages.length > 0) return;
    api.getPages().then((res) => setPages(res.pages || [])).catch((err) => setPagesError(err.message));
  }, [entityType]);

  useEffect(() => {
    if (entityType !== "components" || components.length > 0) return;
    api.getComponents().then((res) => setComponents(res.components || [])).catch((err) => setComponentsError(err.message));
  }, [entityType]);

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

  const orgUnitLabel = settings?.orgUnitUUID ? orgUnitName(settings.orgUnitUUID) : "not set";

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Select & Send</h1>
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
            >
              <ItemSyncAction
                phase={itemPhase}
                entityLabel="item"
                selCount={selectedItemIds.length}
                selWords={selectedItemWords}
                onLaunch={() => setItemPhase("confirm")}
                onCancel={() => setItemPhase("idle")}
                onConfirm={doLaunchItemSync}
                onReset={resetItemSync}
                result={result}
              />
            </SyncSidebar>
          </div>

          {error && <p className="mt-4 text-sm font-medium text-status-error-fg">Error: {error}</p>}
        </>
      )}

      {entityType === "pages" && (
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

            <SyncSidebar orgUnitName={orgUnitLabel} targetLocales={settings?.targetLocales} volumeLabel={`${selectedPageIds.length} selected`}>
              <ItemSyncAction
                phase={pagesItemPhase}
                entityLabel="page"
                selCount={selectedPageIds.length}
                selWords={0}
                onLaunch={() => setPagesItemPhase("confirm")}
                onCancel={() => setPagesItemPhase("idle")}
                onConfirm={doLaunchPagesItemSync}
                onReset={resetPagesItemSync}
                result={pagesResult}
              />
            </SyncSidebar>
          </div>

          {pagesError && <p className="mt-4 text-sm font-medium text-status-error-fg">Error: {pagesError}</p>}
        </>
      )}

      {entityType === "components" && (
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

            <SyncSidebar orgUnitName={orgUnitLabel} targetLocales={settings?.targetLocales} volumeLabel={`${selectedComponentIds.length} selected`}>
              <ItemSyncAction
                phase={componentsItemPhase}
                entityLabel="component"
                selCount={selectedComponentIds.length}
                selWords={0}
                onLaunch={() => setComponentsItemPhase("confirm")}
                onCancel={() => setComponentsItemPhase("idle")}
                onConfirm={doLaunchComponentsItemSync}
                onReset={resetComponentsItemSync}
                result={componentsResult}
              />
            </SyncSidebar>
          </div>

          {componentsError && <p className="mt-4 text-sm font-medium text-status-error-fg">Error: {componentsError}</p>}
        </>
      )}
    </div>
  );
}
