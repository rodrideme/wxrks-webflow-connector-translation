// Pure helpers shared by Translate.jsx's unified content browser and
// SendToWxrksModal. Mirrors server/services/autoSyncRules.js's
// evaluateCondition exactly (kept as a client-side twin, not imported,
// since there's no shared package between client/server in this repo) so
// a filter's live preview here always agrees with how the same condition
// would be evaluated server-side once saved into an automation.

export function evaluateCondition(cond, fieldData) {
  const value = fieldData?.[cond.fieldSlug];
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
    default:
      return false;
  }
}

export function itemMatchesFilters(item, filters) {
  if (!filters || filters.length === 0) return true;
  return filters.every((f) => evaluateCondition(f, item.fieldData));
}

export function leafKey(kind, id) {
  return `${kind}:${id}`;
}

export function entityKey(kind, id) {
  return `${kind}:${id}`;
}
