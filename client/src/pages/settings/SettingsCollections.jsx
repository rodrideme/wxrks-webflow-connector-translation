import { useState } from "react";
import api from "../../services/api.js";
import StatusBadge from "../../components/StatusBadge.jsx";
import { formatDateOnly } from "../../formatDate.js";

const linkButtonClass = "text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline";
const inputClass =
  "rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

const OPERATORS_BY_TYPE = {
  DateTime: [
    { value: "before", label: "before" },
    { value: "after", label: "after" },
    { value: "equals", label: "equals" },
  ],
  Switch: [{ value: "equals", label: "is" }],
  PlainText: [{ value: "equals", label: "equals" }],
};

export default function SettingsCollections({
  collections,
  isCollectionEnabled,
  toggleCollection,
  checkAllCollections,
  uncheckAllCollections,
  isAutoSyncCollectionEnabled,
  toggleAutoSyncCollection,
  checkAllAutoSyncCollections,
  uncheckAllAutoSyncCollections,
  autoSyncFieldConditions,
  timezone,
  onAutoSyncFieldConditionsSaved,
}) {
  const [expanded, setExpanded] = useState(null);
  const [itemsByCollection, setItemsByCollection] = useState({});
  const [configuring, setConfiguring] = useState(null);
  const [fieldsByCollection, setFieldsByCollection] = useState({});
  const [error, setError] = useState(null);

  async function toggleExpand(collectionId) {
    if (expanded === collectionId) {
      setExpanded(null);
      return;
    }
    setExpanded(collectionId);
    if (!itemsByCollection[collectionId]) {
      try {
        const res = await api.getCollectionItems(collectionId);
        setItemsByCollection((prev) => ({ ...prev, [collectionId]: res.items }));
      } catch (err) {
        setError(err.message);
      }
    }
  }

  async function toggleConfigure(collectionId) {
    if (configuring === collectionId) {
      setConfiguring(null);
      return;
    }
    setConfiguring(collectionId);
    if (!fieldsByCollection[collectionId]) {
      try {
        const res = await api.getCollectionFields(collectionId);
        setFieldsByCollection((prev) => ({ ...prev, [collectionId]: res.fields }));
      } catch (err) {
        setError(err.message);
      }
    }
  }

  async function toggleFieldExcluded(collectionId, slug) {
    const fields = fieldsByCollection[collectionId];
    const updatedFields = fields.map((f) => (f.slug === slug ? { ...f, excluded: !f.excluded } : f));
    setFieldsByCollection((prev) => ({ ...prev, [collectionId]: updatedFields }));

    const excludedFields = updatedFields.filter((f) => f.excluded).map((f) => f.slug);
    try {
      await api.updateFieldExclusions(collectionId, excludedFields);
    } catch (err) {
      setError(err.message);
    }
  }

  // Auto Sync Level 3 conditions -- one editable condition per field via this
  // UI (the underlying array could in principle hold more, but that's not
  // exposed here). Saves immediately, same UX as field exclusions above.
  function getCondition(collectionId, slug) {
    return (autoSyncFieldConditions[collectionId] || []).find((c) => c.fieldSlug === slug);
  }

  async function saveCondition(collectionId, slug, fieldType, patch) {
    const existing = autoSyncFieldConditions[collectionId] || [];
    const current = existing.find((c) => c.fieldSlug === slug);
    const next =
      patch === null
        ? existing.filter((c) => c.fieldSlug !== slug)
        : [
            ...existing.filter((c) => c.fieldSlug !== slug),
            { fieldSlug: slug, fieldType, operator: "equals", value: fieldType === "Switch" ? true : "", ...current, ...patch },
          ];
    try {
      await api.updateAutoSyncFieldConditions(collectionId, next);
      onAutoSyncFieldConditionsSaved(collectionId, next);
    } catch (err) {
      setError(err.message);
    }
  }

  function conditionValueInput(collectionId, field, condition) {
    if (!condition) return null;
    if (field.type === "DateTime") {
      return (
        <input
          type="date"
          value={condition.value ? String(condition.value).slice(0, 10) : ""}
          onChange={(e) => saveCondition(collectionId, field.slug, field.type, { value: e.target.value })}
          className={inputClass}
        />
      );
    }
    if (field.type === "Switch") {
      return (
        <select
          value={condition.value ? "true" : "false"}
          onChange={(e) => saveCondition(collectionId, field.slug, field.type, { value: e.target.value === "true" })}
          className={inputClass}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    }
    return (
      <input
        type="text"
        value={condition.value || ""}
        onChange={(e) => saveCondition(collectionId, field.slug, field.type, { value: e.target.value })}
        placeholder="exact text"
        className={inputClass}
      />
    );
  }

  return (
    <div>
      {error && <p className="mb-3 text-sm font-medium text-red-600">Error: {error}</p>}
      {collections.length > 0 && (
        <p className="mb-3">
          <button type="button" className={linkButtonClass} onClick={checkAllCollections}>
            Check all
          </button>{" "}
          ·{" "}
          <button type="button" className={linkButtonClass} onClick={uncheckAllCollections}>
            Uncheck all
          </button>
          {" — manual sync. "}
          <button type="button" className={linkButtonClass} onClick={checkAllAutoSyncCollections}>
            Check all
          </button>{" "}
          ·{" "}
          <button type="button" className={linkButtonClass} onClick={uncheckAllAutoSyncCollections}>
            Uncheck all
          </button>
          {" — Auto Sync."}
        </p>
      )}
      {collections.length === 0 && <p className="text-sm text-slate-500">No collections found.</p>}

      {collections.map((collection) => (
        <section className="mb-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm" key={collection.id}>
          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={isCollectionEnabled(collection.id)}
                onChange={() => toggleCollection(collection.id)}
                className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500"
              />
              Sync this collection
            </label>
            <label className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={isAutoSyncCollectionEnabled(collection.id)}
                onChange={() => toggleAutoSyncCollection(collection.id)}
                className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500"
              />
              Auto Sync this collection
            </label>
            <button
              className="flex items-center gap-1 text-base font-semibold text-slate-900 hover:text-brand-600"
              onClick={() => toggleExpand(collection.id)}
            >
              {collection.displayName || collection.singularName} {expanded === collection.id ? "▾" : "▸"}
            </button>
            <button className={linkButtonClass} onClick={() => toggleConfigure(collection.id)}>
              {configuring === collection.id ? "Hide field config" : "Configure translatable fields"}
            </button>
          </div>

          {configuring === collection.id && (
            <table className="mt-4 w-full text-left text-sm">
              <thead className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="border-b border-slate-200 px-3 py-2">Field</th>
                  <th className="border-b border-slate-200 px-3 py-2">Type</th>
                  <th className="border-b border-slate-200 px-3 py-2">Translate?</th>
                  <th className="border-b border-slate-200 px-3 py-2">Auto Sync condition</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(fieldsByCollection[collection.id] || []).map((field) => {
                  const condition = getCondition(collection.id, field.slug);
                  const supportsCondition = Boolean(OPERATORS_BY_TYPE[field.type]);
                  return (
                    <tr key={field.slug}>
                      <td className="px-3 py-2 text-slate-900">{field.displayName}</td>
                      <td className="px-3 py-2 text-slate-600">{field.type}</td>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={!field.excluded}
                          disabled={!field.translatableByDefault}
                          onChange={() => toggleFieldExcluded(collection.id, field.slug)}
                          className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500 disabled:opacity-50"
                        />
                        {!field.translatableByDefault && <span className="ml-2 text-xs text-slate-500">(not text, fixed)</span>}
                      </td>
                      <td className="px-3 py-2">
                        {!supportsCondition ? (
                          <span className="text-xs text-slate-400">—</span>
                        ) : condition ? (
                          <div className="flex items-center gap-1.5">
                            <select
                              value={condition.operator}
                              onChange={(e) =>
                                saveCondition(collection.id, field.slug, field.type, { operator: e.target.value })
                              }
                              className={inputClass}
                            >
                              {OPERATORS_BY_TYPE[field.type].map((op) => (
                                <option key={op.value} value={op.value}>
                                  {op.label}
                                </option>
                              ))}
                            </select>
                            {conditionValueInput(collection.id, field, condition)}
                            <button
                              type="button"
                              className="text-xs text-red-600 hover:underline"
                              onClick={() => saveCondition(collection.id, field.slug, field.type, null)}
                            >
                              Remove
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className={linkButtonClass}
                            onClick={() => saveCondition(collection.id, field.slug, field.type, {})}
                          >
                            + Add condition
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {expanded === collection.id && (
            <div className="mt-4 max-h-96 overflow-auto rounded-md border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2">Date published</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Locale status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(itemsByCollection[collection.id] || []).map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 text-slate-900">{item.name}</td>
                      <td className="px-3 py-2 text-slate-600">{formatDateOnly(item.lastPublished, timezone)}</td>
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
                      <td className="space-x-2 px-3 py-2">
                        {Object.entries(item.localeStatus || {}).map(([locale, status]) => (
                          <span key={locale} className="inline-flex items-center gap-1 text-sm text-slate-600">
                            {locale}: <StatusBadge status={status} />
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
