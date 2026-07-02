/**
 * Pure Auto Sync rule evaluation -- no network calls, so it's usable
 * identically from the live webhook path (server/routes/webhooks.js) and the
 * reconciliation safety-net path (server/services/autoSyncReconciliation.js)
 * against the same `itemLike` shape (a full item as returned by
 * webflow.getItem()/listAllItems(), i.e. { fieldData, lastPublished,
 * isDraft, isArchived, ... }).
 *
 * 3-level model: Level 1 master enable, Level 2 collection allow-list,
 * Level 3 optional per-field conditions (all must match -- AND semantics).
 * An empty conditions array for an enabled collection means "no Level 3
 * restriction" -- every published item in that collection qualifies.
 */

function evaluateAutoSyncRules(settings, collection, itemLike) {
  const { autoSync } = settings;
  if (!autoSync.enabled) return false;
  if (itemLike.isDraft || itemLike.isArchived) return false;

  const collectionQualifies =
    autoSync.allCollectionsEnabled || autoSync.enabledCollectionIds.includes(collection.id);
  if (!collectionQualifies) return false;

  const conditions = autoSync.fieldConditions[collection.id] || [];
  return conditions.every((cond) => evaluateCondition(cond, itemLike.fieldData));
}

function evaluateCondition(cond, fieldData) {
  const value = fieldData?.[cond.fieldSlug];
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
    default:
      return false;
  }
}

module.exports = { evaluateAutoSyncRules, evaluateCondition };
