/**
 * Shared DOM-node helpers for Webflow static Pages and Components -- both
 * APIs return the identical node-tree shape. Kept separate from webflow.js
 * since this is pure text-tree manipulation, not HTTP calls.
 *
 * Three distinct translatable channels, confirmed live (never overlapping,
 * see below for why the key scheme keeps them apart):
 *  - `type: "text"` nodes -- plain page/component DOM content, keyed by the
 *    bare node id (unchanged since v1).
 *  - `type: "component-instance"` nodes' `propertyOverrides` -- one
 *    specific PLACEMENT's override of a component property. Identified by
 *    the placement's own node id, never by page or component id alone --
 *    confirmed live the same component can be placed twice on one page, at
 *    two different node ids, each independently overridable. Can appear on
 *    a page's own DOM or nested inside another component's own DOM.
 *  - A component definition's own default property values
 *    (webflow.getComponentProperties) -- a channel entirely separate from
 *    that component's DOM nodes (confirmed live: zero overlap between a
 *    component's DOM node list and its properties for the same component).
 *
 * `image` node alt text is still skipped (often a "__wf_reserved_inherit"
 * sentinel rather than real text, and determining which is which reliably
 * needs more live investigation than this pass covered).
 */

const crypto = require("crypto");

const TEXT_NODE_TYPE = "text";
const COMPONENT_INSTANCE_NODE_TYPE = "component-instance";

// Both prefixes contain a literal ":", which a bare Webflow node/property id
// never does (always hyphenated hex/base36) -- so these can never collide
// with a plain node-id key or with each other.
const OVERRIDE_KEY_PREFIX = "override:";
const PROPERTY_KEY_PREFIX = "property:";

function overrideKey(nodeId, propertyId) {
  return `${OVERRIDE_KEY_PREFIX}${nodeId}:${propertyId}`;
}

function propertyKey(propertyId) {
  return `${PROPERTY_KEY_PREFIX}${propertyId}`;
}

/**
 * A genuine DOM text node's `text` field always has BOTH `.html` and
 * `.text` populated (confirmed live all session). A Component Property's
 * (or an override's) `text` field only populates ONE of the two, depending
 * on the property's own type -- Rich Text populates `.html` with `.text:
 * null`, Plain Text populates `.text` with `.html: null` (confirmed live:
 * "Get Started"/" Install CLI" only ever appeared under `.text`). Prefers
 * `.html` (so Rich Text markup round-trips through translation) and falls
 * back to `.text` for the Plain Text case; returns undefined for
 * blank/whitespace-only content either way.
 */
function extractOverridableText(textField) {
  const value = typeof textField?.html === "string" ? textField.html : typeof textField?.text === "string" ? textField.text : undefined;
  if (value === undefined || !value.trim()) return undefined;
  return value;
}

/**
 * Whether a Component Property's (or override's) own label matches any of
 * the account's configured auto-exclude keywords (case-insensitive
 * substring match) -- the automatic layer underneath the manual per-
 * property exclusion list, catching the common case of a Property that's
 * actually a CSS/config value (e.g. "Logo width", "Style", "quote width")
 * without needing to manually toggle each one off. `keywords` is expected
 * already-lowercased (see store.js's PUT /settings normalization), but
 * lowercased again here defensively in case of legacy/direct-DB data.
 */
function labelMatchesKeyword(label, keywords = []) {
  if (!label) return false;
  const lower = label.toLowerCase();
  return keywords.some((kw) => kw && lower.includes(kw.toLowerCase()));
}

/**
 * Extracts translatable text from a page's or component's DOM node list
 * into a flat { [key]: html } dict, analogous to a CMS item's fieldData --
 * exactly the shape syncCore.js's shared batching logic needs (a plain
 * string-valued object to JSON-serialize and upload to wxrks).
 * Uses `text.html` (not the plain `.text`) for plain text nodes so markup
 * round-trips through translation, the same way CMS RichText fields
 * already do; component-instance overrides go through
 * extractOverridableText since their type-dependent shape differs.
 *
 * `exclusionsByComponentId` ({ [componentId]: string[] of excluded
 * propertyIds } -- the account's whole componentPropertyExclusions
 * settings blob, not just one component's list, since a single node list
 * can contain instances of many different components) applies the same
 * per-property exclusion a component's own definition-level properties get
 * (see extractComponentProperties) to a PLACEMENT's override of that same
 * property -- confirmed live, a component-instance node carries its own
 * `componentId`, so an override's propertyId can be checked against that
 * specific component's exclusion list.
 */
function extractTextNodes(nodes = [], exclusionsByComponentId = {}, autoExcludeKeywords = []) {
  const translatable = {};
  for (const node of nodes) {
    if (node.type === TEXT_NODE_TYPE) {
      const html = node.text?.html;
      if (typeof html !== "string") continue;
      const plain = (node.text?.text || "").trim();
      if (!plain) continue; // skip empty/whitespace-only nodes -- nothing to translate
      translatable[node.id] = html;
    } else if (node.type === COMPONENT_INSTANCE_NODE_TYPE) {
      const excluded = new Set(exclusionsByComponentId[node.componentId] || []);
      for (const override of node.propertyOverrides || []) {
        if (excluded.has(override.propertyId)) continue;
        if (labelMatchesKeyword(override.label, autoExcludeKeywords)) continue;
        const value = extractOverridableText(override.text);
        if (value === undefined) continue;
        translatable[overrideKey(node.id, override.propertyId)] = value;
      }
    }
  }
  return translatable;
}

/**
 * Sibling of extractTextNodes for a component definition's own default
 * property values (webflow.getComponentProperties' result) -- a channel
 * entirely separate from that component's DOM nodes. Keyed by
 * propertyKey(propertyId) so these merge into the same translatable dict
 * as a component's DOM text/overrides (see syncCore.js's
 * syncComponentIntoBatch) without ever colliding.
 */
function extractComponentProperties(properties = [], excludedPropertyIds = [], autoExcludeKeywords = []) {
  const excluded = new Set(excludedPropertyIds);
  const translatable = {};
  for (const property of properties) {
    if (excluded.has(property.propertyId)) continue;
    if (labelMatchesKeyword(property.label, autoExcludeKeywords)) continue;
    const value = extractOverridableText(property.text);
    if (value === undefined) continue;
    translatable[propertyKey(property.propertyId)] = value;
  }
  return translatable;
}

/**
 * Splits a flat translated { key: text } dict (built from extractTextNodes
 * + extractComponentProperties) back into the two distinct Webflow writes
 * this app can issue for one page/component:
 *  - `nodeUpdates` -- POST .../dom, one array covering both plain text
 *    nodes ({ nodeId, text }) and component-instance overrides grouped by
 *    node id ({ nodeId, propertyOverrides: [{ propertyId, text }] }),
 *    since one placement can override more than one property.
 *  - `propertyUpdates` -- a wholly separate endpoint
 *    (POST .../components/:id/properties), never mixed into the dom
 *    payload. Always empty for a page (pages have no definition-properties
 *    channel).
 * Replaces the old buildNodeUpdates, which only ever produced the first
 * category.
 */
function splitTranslatedContent(translatedById = {}) {
  const nodeTextById = new Map();
  const overridesByNodeId = new Map();
  const propertyUpdates = [];

  for (const [key, text] of Object.entries(translatedById)) {
    if (key.startsWith(OVERRIDE_KEY_PREFIX)) {
      const rest = key.slice(OVERRIDE_KEY_PREFIX.length); // "{nodeId}:{propertyId}"
      const sep = rest.indexOf(":");
      const nodeId = rest.slice(0, sep);
      const propertyId = rest.slice(sep + 1);
      if (!overridesByNodeId.has(nodeId)) overridesByNodeId.set(nodeId, []);
      overridesByNodeId.get(nodeId).push({ propertyId, text });
    } else if (key.startsWith(PROPERTY_KEY_PREFIX)) {
      propertyUpdates.push({ propertyId: key.slice(PROPERTY_KEY_PREFIX.length), text });
    } else {
      nodeTextById.set(key, text);
    }
  }

  const nodeUpdates = [
    ...[...nodeTextById.entries()].map(([nodeId, text]) => ({ nodeId, text })),
    ...[...overridesByNodeId.entries()].map(([nodeId, propertyOverrides]) => ({ nodeId, propertyOverrides })),
  ];

  return { nodeUpdates, propertyUpdates };
}

/**
 * Content hash of a node list's (+ optionally a component definition's
 * properties') translatable text, used to detect real changes for
 * Pages/Components dedup (see automationScheduler.js and autoSyncQueue.js)
 * instead of trusting a modification timestamp -- Pages' `lastUpdated`
 * gets bumped by a full "Publish site" action regardless of whether that
 * page's content changed, and Components carry no modification timestamp
 * at all. `properties`/`excludedPropertyIds` are omitted for Pages (no
 * definition-properties channel there); passed for Components so a
 * properties-only edit (no DOM node/override touched at all) still changes
 * the hash. `exclusionsByComponentId`/`autoExcludeKeywords` apply to BOTH
 * (a page's or a component's own DOM can each contain component-instance
 * nodes referencing other components' properties) -- an options object
 * rather than more positional params since Pages and Components now need
 * different subsets of these.
 */
function hashNodes(nodes, { properties, excludedPropertyIds, exclusionsByComponentId = {}, autoExcludeKeywords = [] } = {}) {
  const translatableText = {
    ...extractTextNodes(nodes, exclusionsByComponentId, autoExcludeKeywords),
    ...extractComponentProperties(properties, excludedPropertyIds, autoExcludeKeywords),
  };
  return crypto.createHash("sha256").update(JSON.stringify(translatableText)).digest("hex");
}

module.exports = {
  extractTextNodes,
  extractComponentProperties,
  labelMatchesKeyword,
  splitTranslatedContent,
  hashNodes,
  overrideKey,
  propertyKey,
};
