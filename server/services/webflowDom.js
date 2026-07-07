/**
 * Shared DOM-node helpers for Webflow static Pages (and, later, Components
 * -- both APIs return the identical node-tree shape). Kept separate from
 * webflow.js since this is pure text-tree manipulation, not HTTP calls.
 *
 * v1 scope (confirmed live this session): only `type: "text"` nodes are
 * extracted/translated. `component-instance` nodes carry their own
 * translatable text via `propertyOverrides`, but per-instance locale
 * overrides are an explicitly-beta Webflow API surface -- deferred
 * alongside full Components support (see the plan's "Deferred" section).
 * `image` node alt text is also skipped for v1 (often a
 * "__wf_reserved_inherit" sentinel rather than real text, and determining
 * which is which reliably needs more live investigation than this pass
 * covered).
 */

const TEXT_NODE_TYPE = "text";

/**
 * Extracts translatable text from a page's DOM node list into a flat
 * { [nodeId]: html } dict, analogous to a CMS item's fieldData -- this is
 * exactly the shape syncCore.js's shared batching logic needs (a plain
 * string-valued object to JSON-serialize and upload to wxrks).
 * Uses each node's `text.html` (not the plain `.text`) so markup (bold,
 * links, line breaks) round-trips through translation, the same way CMS
 * RichText fields already do.
 */
function extractTextNodes(nodes = []) {
  const translatable = {};
  for (const node of nodes) {
    if (node.type !== TEXT_NODE_TYPE) continue;
    const html = node.text?.html;
    if (typeof html !== "string") continue;
    const plain = (node.text?.text || "").trim();
    if (!plain) continue; // skip empty/whitespace-only nodes -- nothing to translate
    translatable[node.id] = html;
  }
  return translatable;
}

/**
 * Builds the `POST /pages/:id/dom` node-update payload from a
 * { [nodeId]: translatedHtml } dict -- only the nodes actually present are
 * included, so untouched nodes/overrides are left alone (confirmed live:
 * partial updates work correctly).
 */
function buildNodeUpdates(translatedById = {}) {
  return Object.entries(translatedById).map(([nodeId, text]) => ({ nodeId, text }));
}

module.exports = { extractTextNodes, buildNodeUpdates };
