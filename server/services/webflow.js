const axios = require("axios");

const WEBFLOW_API_URL = "https://api.webflow.com/v2";

// Field keys present on every CMS item that are never translatable content.
const NON_TRANSLATABLE_KEYS = new Set(["slug", "id", "_draft", "_archived"]);

function client() {
  const token = process.env.WEBFLOW_API_TOKEN;
  if (!token) {
    throw new Error("WEBFLOW_API_TOKEN is not configured");
  }
  return axios.create({
    baseURL: WEBFLOW_API_URL,
    headers: { Authorization: `Bearer ${token}` },
  });
}

function siteId() {
  const id = process.env.WEBFLOW_SITE_ID;
  if (!id) {
    throw new Error("WEBFLOW_SITE_ID is not configured");
  }
  return id;
}

async function listCollections() {
  const { data } = await client().get(`/sites/${siteId()}/collections`);
  return data?.collections || [];
}

/**
 * IMPORTANT (confirmed live + against Webflow's own docs): the CMS item
 * endpoints do NOT accept a `locale` tag query/body param at all -- reads
 * and writes are scoped exclusively by `cmsLocaleId` (a different id than
 * the `tag` shown in Webflow's UI/site-locales response). Passing `locale`
 * as a query param is silently ignored and always operates on the PRIMARY
 * locale, for both GET and PATCH. A real production incident on this app's
 * target site confirmed this: every "translated" push this session had
 * actually been overwriting the item's PRIMARY content, not a secondary
 * locale, because patchItemLocale used to send `?locale=X` instead of a
 * resolved `cmsLocaleId`. Webflow's own "Update Items" doc states it
 * plainly: "Items will only be updated in the primary locale, unless a
 * cmsLocaleId is included in the request." Every caller must resolve a tag
 * to its cmsLocaleId via resolveCmsLocaleId() before touching an item.
 */
async function getSiteLocales() {
  const { data } = await client().get(`/sites/${siteId()}`);
  const primary = data?.locales?.primary;
  const secondary = data?.locales?.secondary || [];
  return {
    // cmsLocaleId included alongside tag: item webhook payloads identify a
    // locale by cmsLocaleId, not by tag, so Auto Sync's loop-prevention
    // filter needs this to compare against.
    primary: primary && { tag: primary.tag, displayName: primary.displayName, cmsLocaleId: primary.cmsLocaleId },
    secondary: secondary
      .filter((l) => l.enabled)
      .map((l) => ({ tag: l.tag, displayName: l.displayName, cmsLocaleId: l.cmsLocaleId })),
  };
}

// Cached for the process lifetime -- site locale config changes rarely, and
// this avoids an extra GET /sites/:id round trip on every single item
// read/write (some of which, like listAllItems, already loop over pages).
let siteLocalesCache = null;

async function resolveCmsLocaleId(tag) {
  if (!tag) return undefined;
  if (!siteLocalesCache) {
    siteLocalesCache = await getSiteLocales();
  }
  if (siteLocalesCache.primary?.tag === tag) return siteLocalesCache.primary.cmsLocaleId;
  const match = siteLocalesCache.secondary.find((l) => l.tag === tag);
  if (!match) {
    throw new Error(`"${tag}" is not a registered locale on this Webflow site`);
  }
  return match.cmsLocaleId;
}

/**
 * Webhook management (Auto Sync). Registration/listing are scoped under the
 * site (confirmed live), but delete is NOT nested under /sites/:id/webhooks/
 * -- it's a top-level /webhooks/:id route (confirmed live; the nested path
 * 404s). Registration confirmed live to only need whatever scope this
 * account's WEBFLOW_API_TOKEN already has (worked without any token change).
 */
async function registerWebhook(triggerType, url) {
  const { data } = await client().post(`/sites/${siteId()}/webhooks`, { triggerType, url });
  return data;
}

async function listWebhooks() {
  const { data } = await client().get(`/sites/${siteId()}/webhooks`);
  return data?.webhooks || [];
}

async function deleteWebhook(webhookId) {
  await client().delete(`/webhooks/${webhookId}`);
}

async function getCollection(collectionId) {
  const { data } = await client().get(`/collections/${collectionId}`);
  return data;
}

/**
 * Fetch all items in a collection for a given locale, handling pagination
 * (Webflow caps each page at 100 items).
 */
async function listAllItems(collectionId, { locale } = {}) {
  const cmsLocaleId = await resolveCmsLocaleId(locale);
  const limit = 100;
  let offset = 0;
  let items = [];

  while (true) {
    const { data } = await client().get(`/collections/${collectionId}/items`, {
      params: { cmsLocaleId, limit, offset },
    });
    const page = data?.items || [];
    items = items.concat(page);

    const total = data?.pagination?.total ?? items.length;
    offset += limit;
    if (items.length >= total || page.length === 0) break;
  }

  return items;
}

async function getItem(collectionId, itemId, { locale } = {}) {
  const cmsLocaleId = await resolveCmsLocaleId(locale);
  const { data } = await client().get(`/collections/${collectionId}/items/${itemId}`, {
    params: { cmsLocaleId },
  });
  return data;
}

/**
 * Updates one locale's field data for an item. Uses the bulk "Update Items"
 * endpoint (there is no single-item PATCH that accepts cmsLocaleId) with a
 * single-element items array -- the single-item endpoint used previously
 * silently ignored locale scoping entirely (see resolveCmsLocaleId's doc
 * comment above).
 */
async function patchItemLocale(collectionId, itemId, locale, fieldData) {
  const cmsLocaleId = await resolveCmsLocaleId(locale);
  const { data } = await client().patch(`/collections/${collectionId}/items`, {
    items: [{ id: itemId, cmsLocaleId, fieldData }],
  });
  return data;
}

async function publishItems(collectionId, itemIds) {
  const { data } = await client().post(`/collections/${collectionId}/items/publish`, {
    itemIds,
  });
  return data;
}

// Webflow field schema types that hold free-form text worth translating.
const TRANSLATABLE_FIELD_TYPES = new Set(["PlainText", "RichText"]);

function isFieldTypeTranslatable(type) {
  return TRANSLATABLE_FIELD_TYPES.has(type);
}

/**
 * Value-shape fallback for when a collection's field schema isn't available.
 * Skips known structural keys plus any non-string/richtext-shaped values
 * (dates, booleans, references, colors, URLs, etc).
 */
function isTranslatableField(key, value) {
  if (NON_TRANSLATABLE_KEYS.has(key)) return false;
  if (key.startsWith("_")) return false;
  if (value === null || value === undefined) return false;

  if (typeof value === "string") {
    const isIsoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value);
    const isMongoId = /^[a-f0-9]{24}$/i.test(value);
    const isHexColor = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
    const isCssColorFunction = /^(rgba?|hsla?)\(/i.test(value.trim());
    const isUrl = /^(https?:)?\/\//i.test(value.trim());
    return !isIsoDate && !isMongoId && !isHexColor && !isCssColorFunction && !isUrl;
  }

  return false;
}

/**
 * Maps a collection's field slugs to their real Webflow schema type
 * (PlainText, RichText, Color, Switch, DateTime, Reference, Image, etc).
 */
function getFieldTypeMap(collection) {
  const map = {};
  (collection.fields || []).forEach((f) => {
    map[f.slug] = f.type;
  });
  return map;
}

/**
 * Field schema for the Settings/Collections UI: every field with its real
 * type and whether it's translatable by default, so users can review and
 * override per-collection exclusions.
 */
function listFieldSchema(collection) {
  return (collection.fields || [])
    .filter((f) => !NON_TRANSLATABLE_KEYS.has(f.slug))
    .map((f) => ({
      slug: f.slug,
      displayName: f.displayName,
      type: f.type,
      translatableByDefault: isFieldTypeTranslatable(f.type),
    }));
}

/**
 * Filter a Webflow item's fieldData down to the fields that should be sent
 * to the TMS for translation. Uses the collection's real field schema type
 * as the primary signal (most reliable), falls back to a value-shape
 * heuristic when no schema is available, and always honors an explicit
 * per-collection exclusion list (user overrides from the Collections UI).
 */
function filterTranslatableFields(fieldData = {}, fieldTypeBySlug = {}, excludedSlugs = []) {
  const excluded = new Set(excludedSlugs);
  return Object.entries(fieldData).reduce((acc, [key, value]) => {
    if (excluded.has(key)) return acc;
    // Structural keys (slug, id, _draft, _archived, _*) must be excluded
    // regardless of the field's Webflow schema type -- `slug` in particular
    // is typically typed "PlainText" in the schema, so without this check it
    // would slip past the type-based translatable check below and get sent
    // to wxrks for translation. wxrks then returns free-form translated
    // text for it, which Webflow's PATCH validation rejects (slugs must
    // match `^[_a-zA-Z0-9][-_a-zA-Z0-9]*$`), silently failing every
    // translation push-back for any item whose fieldData includes a slug
    // (confirmed live -- this was breaking every real delivery this session).
    if (NON_TRANSLATABLE_KEYS.has(key) || key.startsWith("_")) return acc;

    const type = fieldTypeBySlug[key];
    const translatable = type ? isFieldTypeTranslatable(type) : isTranslatableField(key, value);
    if (translatable) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

/**
 * Rough word-count estimate for a set of translatable field values --
 * strips RichText's HTML markup first so tags don't inflate the count.
 */
function countWords(translatableFields = {}) {
  return Object.values(translatableFields).reduce((total, value) => {
    if (typeof value !== "string") return total;
    const text = value.replace(/<[^>]*>/g, " ");
    const words = text.trim().split(/\s+/).filter(Boolean);
    return total + words.length;
  }, 0);
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";
}

const DEFAULT_WORK_UNIT_NAME_PATTERN = "{collection}-{entry}";

/**
 * Builds the wxrks resource file name (which is what shows up as the work
 * unit name -- wxrks derives it from the uploaded file, there's no separate
 * "work unit name" field in the API) from a user-configurable pattern with
 * {collection}/{entry} placeholders. One resource/work unit is created per
 * Webflow entry (all of its translatable fields bundled into that one file),
 * so there's no per-field token.
 */
function buildResourceFileName(pattern, { collection, item }) {
  const collectionToken = collection.slug || slugify(collection.displayName || collection.id);
  const entryToken = item.fieldData?.slug || slugify(item.fieldData?.name || item.id);

  const name = (pattern || DEFAULT_WORK_UNIT_NAME_PATTERN)
    .replace(/{collection}/g, collectionToken)
    .replace(/{entry}/g, entryToken)
    .replace(/{field}/g, "");

  return `${name}.json`;
}

module.exports = {
  listCollections,
  getCollection,
  getSiteLocales,
  listAllItems,
  getItem,
  patchItemLocale,
  publishItems,
  filterTranslatableFields,
  isTranslatableField,
  getFieldTypeMap,
  listFieldSchema,
  buildResourceFileName,
  countWords,
  DEFAULT_WORK_UNIT_NAME_PATTERN,
  registerWebhook,
  listWebhooks,
  deleteWebhook,
};
