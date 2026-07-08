import { useState } from "react";
import api from "../services/api.js";
import Toggle from "./Toggle.jsx";
import Card from "./Card.jsx";

const linkButtonClass = "text-xs font-medium text-accent-text hover:underline";
const inputClass =
  "rounded-md border border-border-strong bg-surface px-2 py-1 text-xs text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

const OPERATORS_BY_TYPE = {
  DateTime: [
    { value: "before", label: "before" },
    { value: "after", label: "after" },
    { value: "equals", label: "equals" },
  ],
  Switch: [{ value: "equals", label: "is" }],
  PlainText: [{ value: "equals", label: "equals" }],
};

function conditionValueInput(field, condition, onChange) {
  if (!condition) return null;
  if (field.type === "DateTime") {
    return (
      <input
        type="date"
        value={condition.value ? String(condition.value).slice(0, 10) : ""}
        onChange={(e) => onChange({ value: e.target.value })}
        className={inputClass}
      />
    );
  }
  if (field.type === "Switch") {
    return (
      <select value={condition.value ? "true" : "false"} onChange={(e) => onChange({ value: e.target.value === "true" })} className={inputClass}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  return (
    <input
      type="text"
      value={condition.value || ""}
      onChange={(e) => onChange({ value: e.target.value })}
      placeholder="exact text"
      className={inputClass}
    />
  );
}

/**
 * Controlled editor for an automation's CMS content scope: which
 * collections qualify (Level 2) and, per collection, optional per-field
 * conditions (Level 3) -- extracted from Settings > Collections' old
 * Auto Sync condition builder so the same rule-building UI can be embedded
 * in NewAutomationModal. Unlike that inline version, this persists nothing
 * itself -- all edits flow through `onChange`, saved once at the modal's
 * own Save button.
 *
 * Doesn't reuse Disclosure/DisclosureRow here: this row needs a checkbox in
 * its header, and Disclosure's header is a real <button> -- nesting an
 * <input>/<label> inside a <button> is invalid HTML. This uses its own
 * plain-div expand/collapse instead.
 */
export default function CmsAutomationScopeEditor({ value, onChange, collections }) {
  const [openCollectionId, setOpenCollectionId] = useState(null);
  const [itemCountByCollection, setItemCountByCollection] = useState({});
  const [fieldsByCollection, setFieldsByCollection] = useState({});
  const [error, setError] = useState(null);

  async function loadMeta(collectionId) {
    if (fieldsByCollection[collectionId]) return;
    try {
      const [fieldsRes, itemsRes] = await Promise.all([
        api.getCollectionFields(collectionId),
        api.getCollectionItems(collectionId),
      ]);
      setFieldsByCollection((prev) => ({ ...prev, [collectionId]: fieldsRes.fields }));
      setItemCountByCollection((prev) => ({ ...prev, [collectionId]: itemsRes.items.length }));
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleOpen(collectionId) {
    const next = openCollectionId === collectionId ? null : collectionId;
    setOpenCollectionId(next);
    if (next) loadMeta(collectionId);
  }

  function isCollectionEnabled(collectionId) {
    return value.allCollectionsEnabled || value.enabledCollectionIds.includes(collectionId);
  }

  function toggleCollection(collectionId) {
    if (value.allCollectionsEnabled) return; // no-op while "all" is on -- toggle that off first
    const enabledCollectionIds = value.enabledCollectionIds.includes(collectionId)
      ? value.enabledCollectionIds.filter((id) => id !== collectionId)
      : [...value.enabledCollectionIds, collectionId];
    onChange({ ...value, enabledCollectionIds });
  }

  function getCondition(collectionId, slug) {
    return (value.fieldConditions[collectionId] || []).find((c) => c.fieldSlug === slug);
  }

  function saveCondition(collectionId, slug, fieldType, patch) {
    const existing = value.fieldConditions[collectionId] || [];
    const current = existing.find((c) => c.fieldSlug === slug);
    const next =
      patch === null
        ? existing.filter((c) => c.fieldSlug !== slug)
        : [
            ...existing.filter((c) => c.fieldSlug !== slug),
            { fieldSlug: slug, fieldType, operator: "equals", value: fieldType === "Switch" ? true : "", ...current, ...patch },
          ];
    onChange({ ...value, fieldConditions: { ...value.fieldConditions, [collectionId]: next } });
  }

  return (
    <div>
      <label className="mb-3 flex items-center gap-2 text-sm text-ink-soft">
        <Toggle
          checked={value.allCollectionsEnabled}
          onChange={(e) => onChange({ ...value, allCollectionsEnabled: e.target.checked })}
          label="All collections"
        />
        All collections
      </label>

      {error && <p className="mb-3 text-sm font-medium text-status-error-fg">Error: {error}</p>}

      <div className={"flex flex-col gap-2" + (value.allCollectionsEnabled ? " pointer-events-none opacity-40" : "")}>
        {collections.map((collection) => {
          const fields = fieldsByCollection[collection.id];
          const itemCount = itemCountByCollection[collection.id];
          const isOpen = openCollectionId === collection.id;
          const conditionableFields = fields?.filter((f) => OPERATORS_BY_TYPE[f.type]) || [];
          return (
            <Card key={collection.id}>
              <div className="flex items-center gap-3 px-3.5 py-2.5">
                <label className="flex flex-1 items-center gap-2 text-sm">
                  <Toggle
                    checked={isCollectionEnabled(collection.id)}
                    onChange={() => toggleCollection(collection.id)}
                    label={`Include ${collection.displayName || collection.singularName}`}
                  />
                  <span className="font-medium text-ink">{collection.displayName || collection.singularName}</span>
                </label>
                {itemCount !== undefined && (
                  <span className="font-mono text-xs tabular-nums text-ink-faint">{itemCount} items</span>
                )}
                <button
                  type="button"
                  onClick={() => toggleOpen(collection.id)}
                  className="text-xs font-medium text-accent-text hover:underline"
                >
                  {isOpen ? "Hide rules" : "Field rules"}
                </button>
              </div>

              {isOpen && (
                <div className="border-t border-border bg-surface-sunken px-3.5 py-2.5">
                  {!fields ? (
                    <p className="text-xs text-ink-faint">Loading fields...</p>
                  ) : conditionableFields.length === 0 ? (
                    <p className="text-xs text-ink-faint">No conditionable fields (DateTime/Switch/PlainText) in this collection.</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {conditionableFields.map((field) => {
                        const condition = getCondition(collection.id, field.slug);
                        return (
                          <div key={field.slug} className="flex items-center justify-between gap-3 text-sm">
                            <span>
                              <span className="font-medium text-ink">{field.displayName}</span>{" "}
                              <span className="text-ink-faint">— {field.type}</span>
                            </span>
                            {condition ? (
                              <div className="flex items-center gap-1.5">
                                <select
                                  value={condition.operator}
                                  onChange={(e) => saveCondition(collection.id, field.slug, field.type, { operator: e.target.value })}
                                  className={inputClass}
                                >
                                  {OPERATORS_BY_TYPE[field.type].map((op) => (
                                    <option key={op.value} value={op.value}>
                                      {op.label}
                                    </option>
                                  ))}
                                </select>
                                {conditionValueInput(field, condition, (patch) => saveCondition(collection.id, field.slug, field.type, patch))}
                                <button
                                  type="button"
                                  className="text-xs text-status-error-fg hover:underline"
                                  onClick={() => saveCondition(collection.id, field.slug, field.type, null)}
                                >
                                  Remove
                                </button>
                              </div>
                            ) : (
                              <button type="button" className={linkButtonClass} onClick={() => saveCondition(collection.id, field.slug, field.type, {})}>
                                + Add condition
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
