// Pure helpers shared by Translate.jsx's unified content browser and
// SendToWxrksModal. Mirrors server/services/autoSyncRules.js's
// evaluateCondition exactly (kept as a client-side twin, not imported,
// since there's no shared package between client/server in this repo) so
// a filter's live preview here always agrees with how the same condition
// would be evaluated server-side once saved into an automation.

// Webflow's own standard CMS item metadata (Created On / Published On /
// Updated On) -- confirmed live on the raw item shape (see
// routes/webhooks.js's item-published payload comment) but never part of a
// collection's own field schema, so these live at the top level of an item
// (item.createdOn etc.), sibling to fieldData, not inside it. Translate.jsx
// injects synthetic field descriptors using these exact slugs into a
// collection's filterable fields list; evaluateCondition below resolves
// them from the entity itself rather than fieldData.
export const STANDARD_DATE_FIELD_KEYS = {
  _createdOn: "createdOn",
  _lastPublished: "lastPublished",
  _lastUpdated: "lastUpdated",
};

// Webflow's own real publish state -- "draft" | "published" | "changed"
// (edited since last publish) | "archived" -- computed generically enough
// to work across the 3 different raw shapes this app deals with: CMS items
// (isDraft/isArchived/lastPublished, confirmed live), static pages
// (draft/archived, no lastPublished field at all, confirmed live -- so
// "changed" can never be detected for a page, only draft/archived/
// published), and components (confirmed live: no date/status field of any
// kind). Returns null when there's simply no signal to go on at all
// (components), rather than guessing "published".
export function computeWebflowStatus(entity) {
  if (!entity) return null;
  const hasAnySignal = "isDraft" in entity || "draft" in entity || "isArchived" in entity || "archived" in entity || "lastPublished" in entity;
  if (!hasAnySignal) return null;
  const archived = entity.isArchived ?? entity.archived ?? false;
  const draft = entity.isDraft ?? entity.draft ?? false;
  if (archived) return "archived";
  if (draft) return "draft";
  if ("lastPublished" in entity) {
    if (!entity.lastPublished) return "draft";
    if (entity.lastUpdated && new Date(entity.lastUpdated).getTime() > new Date(entity.lastPublished).getTime()) return "changed";
  }
  return "published";
}

export function evaluateCondition(cond, entity) {
  const standardKey = STANDARD_DATE_FIELD_KEYS[cond.fieldSlug];
  const value = standardKey ? entity?.[standardKey] : entity?.fieldData?.[cond.fieldSlug];
  switch (cond.fieldType) {
    case "DateTime": {
      if (value == null) return false;
      const actual = new Date(value).getTime();
      const target = new Date(cond.value).getTime();
      if (cond.operator === "before") return actual < target;
      if (cond.operator === "after") return actual > target;
      return actual === target;
    }
    case "Switch":
      return Boolean(value) === Boolean(cond.value);
    case "PlainText":
      return String(value ?? "") === String(cond.value);
    // cond.value is always an array of picked linked-item ids, even for a
    // single-value Reference pick -- lets one filter row match ANY of
    // several picked options (the only way to express "Tag A or Tag B" at
    // all, since separate filter rows are ANDed together, not ORed).
    case "Reference": {
      const matches = Array.isArray(cond.value) && cond.value.includes(value);
      return cond.operator === "notEquals" ? !matches : matches;
    }
    case "MultiReference": {
      const itemIds = Array.isArray(value) ? value : [];
      const matches = Array.isArray(cond.value) && cond.value.some((id) => itemIds.includes(id));
      return cond.operator === "notEquals" ? !matches : matches;
    }
    case "WebflowStatus": {
      const matches = computeWebflowStatus(entity) === cond.value;
      return cond.operator === "notEquals" ? !matches : matches;
    }
    default:
      return false;
  }
}

export function itemMatchesFilters(item, filters) {
  if (!filters || filters.length === 0) return true;
  return filters.every((f) => evaluateCondition(f, item));
}

export function leafKey(kind, id) {
  return `${kind}:${id}`;
}

export function entityKey(kind, id) {
  return `${kind}:${id}`;
}
