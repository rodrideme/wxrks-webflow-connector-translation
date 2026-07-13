/**
 * Pure per-field condition evaluation -- no network calls, so it's usable
 * identically from the live webhook path (server/routes/webhooks.js), the
 * reconciliation safety-net path (server/services/autoSyncReconciliation.js),
 * and store.js's isAutomationCmsItemQualified, all against the same
 * `itemLike` shape (a full item as returned by webflow.getItem()/
 * listAllItems(), i.e. { fieldData, lastPublished, isDraft, isArchived, ... }).
 * evaluateCondition takes this whole entity (not just fieldData) so it can
 * also resolve Webflow's standard Created On/Published On/Updated On dates,
 * which live at the top level of the item, not inside fieldData.
 *
 * An empty conditions array for a qualifying collection means "no Level 3
 * restriction" -- every published item in that collection qualifies.
 */

// Kept in sync with client/src/leafHelpers.js's identical map -- see that
// file's comment for why these live at the top level of an item, not
// inside fieldData.
const STANDARD_DATE_FIELD_KEYS = {
  _createdOn: "createdOn",
  _lastPublished: "lastPublished",
  _lastUpdated: "lastUpdated",
};

function evaluateCondition(cond, entity) {
  const standardKey = STANDARD_DATE_FIELD_KEYS[cond.fieldSlug];
  const value = standardKey ? entity?.[standardKey] : entity?.fieldData?.[cond.fieldSlug];
  switch (cond.fieldType) {
    case "DateTime": {
      if (value == null) return false;
      const actual = new Date(value).getTime();
      const target = new Date(cond.value).getTime();
      if (cond.operator === "before") return actual < target;
      if (cond.operator === "after") return actual > target;
      return actual === target; // "equals"
    }
    case "Switch":
      return Boolean(value) === Boolean(cond.value);
    case "PlainText":
      return String(value ?? "") === String(cond.value);
    // Kept in sync with client/src/leafHelpers.js's identical cases -- see
    // that file's comment for why cond.value is always an array.
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

module.exports = { evaluateCondition };
