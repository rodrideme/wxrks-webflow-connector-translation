const axios = require("axios");

const WEBFLOW_API_URL = "https://api.webflow.com/v2";

// Field keys present on every CMS item that are never translatable content.
const NON_TRANSLATABLE_KEYS = new Set(["slug", "id", "_draft", "_archived"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Phase 2 (multi-user login): each account uses its own Webflow OAuth token
// (see store.getWebflowConnection), identified implicitly via
// accountContext -- see that module's docstring for why this is an
// AsyncLocalStorage-based context rather than an explicit parameter here.
// Falls back to the static env-configured token/site for any account that
// has never connected its own Webflow site via OAuth (in practice, just
// "Account #1", migrated from this app's original single-tenant setup
// before accounts existed at all) -- lazy-required to avoid a circular
// require (store.js itself requires this file for a few constants).
async function resolveConnection() {
  const accountContext = require("./accountContext");
  const store = require("../store");
  const accountId = accountContext.getAccountId();
  const connection = await store.getWebflowConnection(accountId);
  if (connection) return connection;
  return { accessToken: process.env.WEBFLOW_API_TOKEN, webflowSiteId: process.env.WEBFLOW_SITE_ID };
}

async function client() {
  const { accessToken } = await resolveConnection();
  if (!accessToken) {
    throw new Error("This account hasn't connected a Webflow site, and WEBFLOW_API_TOKEN isn't configured either");
  }
  const instance = axios.create({
    baseURL: WEBFLOW_API_URL,
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Confirmed live (Pages Phase 2 testing): Webflow starts returning 429s
  // after ~40 rapid sequential requests -- easily hit when fetching one
  // DOM per page across a real site (unlike CMS items, which batch
  // fieldData into one paginated call per collection). Retries honor
  // Retry-After when present, else back off with a fixed delay.
  //
  // Deliberately NOT retrying 403 here (tried once, reverted): the
  // Translate page's "All content" mode fetches every collection's full
  // item list, which itself fires 1 + targetLocales.length paginated
  // Webflow calls PER collection (see routes/collections.js's GET
  // /:id/items) -- easily dozens of rapid calls, the same volume that
  // trips Webflow's throttling above. Retrying 403 there too meant any
  // real (even occasional) 403 across that whole burst got retried up to
  // 5x with backoff instead of failing fast, which could inflate total
  // load time enough to look like a permanently stuck loading state.
  // listPages()'s TTL cache (below, via makeTtlCache) already fixes the
  // specific redundant-concurrent-request 403 this was originally added
  // for, without this broader latency risk.
  instance.interceptors.response.use(undefined, async (error) => {
    const { config, response } = error;
    if (response?.status !== 429 || !config || config.__retryCount >= 5) {
      throw error;
    }
    config.__retryCount = (config.__retryCount || 0) + 1;
    const retryAfterSeconds = Number(response.headers?.["retry-after"]);
    const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 1000;
    await sleep(delayMs);
    return instance.request(config);
  });

  return instance;
}

async function siteId() {
  const { webflowSiteId } = await resolveConnection();
  if (!webflowSiteId) {
    throw new Error("This account hasn't connected a Webflow site, and WEBFLOW_SITE_ID isn't configured either");
  }
  return webflowSiteId;
}

// Structural Webflow content (collection/page/component *lists*, not item
// content) changes only when someone edits it in Webflow's own Designer --
// this app never creates/deletes/renames a collection, page, or component
// itself, so there's no self-consistency risk in serving a slightly stale
// list back to this app's own writes. This TTL only trades off "how long
// until an external Designer edit becomes visible here" against "how many
// redundant Webflow round trips a burst of navigation/polling causes" --
// 30 minutes is still far shorter than any realistic edit-then-immediately-
// need-it workflow, and far shorter than automationScheduler.js's own
// hourly/daily/weekly scan cadence. Matches the client's dataCache TTL so a
// cold client-side cache (e.g. a new tab) doesn't still pay for a slow
// live Webflow round trip on the server side either.
const STRUCTURAL_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Wraps a zero-arg fetch function in a per-account TTL cache, mirroring
 * siteLocalesCacheByAccount's Map-keyed-by-accountId idiom below but with
 * an expiry (that cache is intentionally process-lifetime-only; this one
 * is not). Caches the in-flight PROMISE, not its resolved value, so
 * concurrent callers within the same tick also dedupe onto one real
 * Webflow request -- this subsumes the old inFlightStaticPagesByAccount
 * concurrent-caller dedup for every wrapped function, not just one. A
 * rejected promise is evicted immediately so a transient failure doesn't
 * poison the cache for the rest of the TTL window.
 */
function makeTtlCache(fetchFn, ttlMs = STRUCTURAL_CACHE_TTL_MS) {
  const byAccount = new Map();
  return async function cached() {
    const accountContext = require("./accountContext");
    const accountId = accountContext.getAccountId();
    const entry = byAccount.get(accountId);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    const promise = fetchFn();
    promise.catch(() => byAccount.delete(accountId));
    byAccount.set(accountId, { value: promise, expiresAt: Date.now() + ttlMs });
    return promise;
  };
}

async function fetchCollections() {
  const { data } = await (await client()).get(`/sites/${await siteId()}/collections`);
  return data?.collections || [];
}
const listCollections = makeTtlCache(fetchCollections);

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
async function fetchSiteLocales() {
  const { data } = await (await client()).get(`/sites/${await siteId()}`);
  const primary = data?.locales?.primary;
  const secondary = data?.locales?.secondary || [];
  return {
    // For the Dashboard's "Webflow connected" checklist row. `previewUrl`
    // (confirmed live) is a Webflow-generated screenshot PNG, NOT a site
    // URL -- don't use it. `customDomains[0].url` (assumed `{id, url}` per
    // Webflow's docs, not yet confirmed live on an account with one bound)
    // is preferred when present; otherwise fall back to the always-valid
    // default `<shortName>.webflow.io` staging domain.
    site: {
      displayName: data?.displayName,
      shortName: data?.shortName,
      url: (data?.customDomains?.[0]?.url && `https://${data.customDomains[0].url}`) || `https://${data?.shortName}.webflow.io`,
    },
    // cmsLocaleId included alongside tag: item webhook payloads identify a
    // locale by cmsLocaleId, not by tag, so Auto Sync's loop-prevention
    // filter needs this to compare against.
    primary: primary && { tag: primary.tag, displayName: primary.displayName, cmsLocaleId: primary.cmsLocaleId },
    // Not filtered to `enabled` locales -- a locale can exist and hold real
    // CMS/Pages/Components content well before its own "publish to
    // subdirectory" toggle is on (confirmed independent per Webflow's own
    // docs), and translating ahead of that toggle is exactly the point:
    // it avoids exposing thousands of untranslated items the moment a
    // client makes a new locale public. `enabled` is passed through
    // instead of used to hide anything, so callers (the Send to wxrks
    // wizard in particular) can choose not to pre-select a locale that
    // isn't public yet, without hiding it as an option entirely.
    // `subdirectory` (confirmed live) is this locale's own URL prefix --
    // not always a simple transform of `tag` (e.g. "pt-BR" -> "pt",
    // "fr-FR" -> "fr") -- pass it through rather than deriving it, so
    // callers building a target-locale's real published URL never guess.
    secondary: secondary.map((l) => ({ tag: l.tag, displayName: l.displayName, cmsLocaleId: l.cmsLocaleId, enabled: l.enabled, subdirectory: l.subdirectory })),
  };
}
// TTL-cached (mirrors listPages/listCollections/listComponents/
// listPageFolders above) -- site locale config changes rarely, and this
// was being fetched fresh on every single /work-units call (one per run),
// so N concurrent calls fired N identical GET /sites/:id requests. That
// redundant fan-out, on top of EAGER_LOAD_CONCURRENCY, was a real
// contributor to tripping Webflow's ~40-rapid-request throttling
// threshold (see Runs.jsx's EAGER_LOAD_CONCURRENCY comment) -- confirmed
// live as part of the same investigation. makeTtlCache also dedupes
// concurrent callers within the same tick onto one in-flight request, not
// just repeat callers after the fact.
const getSiteLocales = makeTtlCache(fetchSiteLocales);

// Cached for the process lifetime -- site locale config changes rarely, and
// this avoids an extra GET /sites/:id round trip on every single item
// read/write (some of which, like listAllItems, already loop over pages).
// Keyed by accountId (Phase 2, multi-user login): different accounts are
// different Webflow sites with different locale configs, so a single
// shared cache would leak one account's locales into another's requests.
const siteLocalesCacheByAccount = new Map();

// wxrks echoes a work unit's locale back in its own lowercase/underscore
// convention (confirmed live: a real delivery reported "fr_fr" for a site
// whose actual registered Webflow tag is "fr-FR") -- this app itself sends
// wxrks the real Webflow tag when creating the work unit, so wxrks is
// reformatting it, not substituting a different locale. Every match against
// Webflow's real tags goes through this normalizer on both sides so a
// case/separator difference alone never produces a false "not registered"
// error; the *real* Webflow tag (with its real casing/separator) is still
// what gets returned and used in the actual API call.
function normalizeLocaleTag(tag) {
  return String(tag || "").toLowerCase().replace(/_/g, "-");
}

async function resolveCmsLocaleId(tag) {
  if (!tag) return undefined;
  const accountContext = require("./accountContext");
  const accountId = accountContext.getAccountId();
  if (!siteLocalesCacheByAccount.has(accountId)) {
    siteLocalesCacheByAccount.set(accountId, await getSiteLocales());
  }
  const cache = siteLocalesCacheByAccount.get(accountId);
  const normalized = normalizeLocaleTag(tag);
  if (normalizeLocaleTag(cache.primary?.tag) === normalized) return cache.primary.cmsLocaleId;
  const match = cache.secondary.find((l) => normalizeLocaleTag(l.tag) === normalized);
  if (!match) {
    throw new Error(`"${tag}" is not a registered locale on this Webflow site`);
  }
  return match.cmsLocaleId;
}

// Full site-locale objects (with the plain `id` field, not just
// `cmsLocaleId`) -- Pages/Components use a DIFFERENT locale id than CMS
// items do (confirmed live: passing a cmsLocaleId into a Pages /dom call
// 400s "must be a valid locale"). Cached alongside siteLocalesCacheByAccount
// since both come from the same GET /sites/:id call; same per-account
// keying and same reasoning.
const rawSiteLocalesCacheByAccount = new Map();

async function getRawSiteLocales() {
  const accountContext = require("./accountContext");
  const accountId = accountContext.getAccountId();
  if (!rawSiteLocalesCacheByAccount.has(accountId)) {
    const { data } = await (await client()).get(`/sites/${await siteId()}`);
    rawSiteLocalesCacheByAccount.set(accountId, {
      primary: data?.locales?.primary,
      // Not filtered to `enabled` -- see getSiteLocales()'s identical
      // reasoning above. Kept in sync deliberately: without this, Pages/
      // Components would keep silently rejecting a not-yet-public locale
      // ("not a registered locale") even after CMS items correctly
      // gained support for it via getSiteLocales() alone.
      secondary: data?.locales?.secondary || [],
    });
  }
  return rawSiteLocalesCacheByAccount.get(accountId);
}

/**
 * Resolves a locale tag to the id Pages/Components' /dom endpoints expect
 * -- the site locale's plain `id` field, distinct from CMS items'
 * `cmsLocaleId` (see comment above). Confirmed live: POST /dom rejects a
 * primary-locale id with a clear 400 ("must be a valid secondary locale"),
 * so no silent-fallback risk here the way the old CMS `?locale=` bug had --
 * still worth a defensive client-side check (see updatePageDom) for a
 * faster, clearer error attributable to our own code.
 */
async function resolvePageLocaleId(tag) {
  if (!tag) return undefined;
  const locales = await getRawSiteLocales();
  const normalized = normalizeLocaleTag(tag);
  if (normalizeLocaleTag(locales.primary?.tag) === normalized) return locales.primary.id;
  const match = locales.secondary.find((l) => normalizeLocaleTag(l.tag) === normalized);
  if (!match) {
    throw new Error(`"${tag}" is not a registered locale on this Webflow site`);
  }
  return match.id;
}

async function isPrimaryPageLocaleId(localeId) {
  const locales = await getRawSiteLocales();
  return locales.primary?.id === localeId;
}

/**
 * Webhook management (Auto Sync). Registration/listing are scoped under the
 * site (confirmed live), but delete is NOT nested under /sites/:id/webhooks/
 * -- it's a top-level /webhooks/:id route (confirmed live; the nested path
 * 404s). Registration confirmed live to only need whatever scope this
 * account's WEBFLOW_API_TOKEN already has (worked without any token change).
 */
async function registerWebhook(triggerType, url) {
  const { data } = await (await client()).post(`/sites/${await siteId()}/webhooks`, { triggerType, url });
  return data;
}

async function listWebhooks() {
  const { data } = await (await client()).get(`/sites/${await siteId()}/webhooks`);
  return data?.webhooks || [];
}

async function deleteWebhook(webhookId) {
  await (await client()).delete(`/webhooks/${webhookId}`);
}

async function getCollection(collectionId) {
  const { data } = await (await client()).get(`/collections/${collectionId}`);
  return data;
}

/**
 * Lists every static page on the site, including CMS collection template
 * pages (those have a non-null `collectionId` and are already handled by
 * the CMS item sync -- callers should filter them out; see
 * `listStaticPages` below). Paginated the same way as `listAllItems`.
 */
async function fetchPages() {
  const limit = 100;
  let offset = 0;
  let pages = [];

  while (true) {
    const { data } = await (await client()).get(`/sites/${await siteId()}/pages`, { params: { limit, offset } });
    const page = data?.pages || [];
    pages = pages.concat(page);

    const total = data?.pagination?.total ?? pages.length;
    offset += limit;
    if (pages.length >= total || page.length === 0) break;
  }

  return pages;
}
const listPages = makeTtlCache(fetchPages);

/**
 * `listPages()` filtered to real static pages -- excludes CMS collection
 * template pages (identified by a non-null `collectionId`), which aren't
 * standalone translatable content and are already covered by CMS item sync.
 * listPages() is already TTL-cached (and dedupes concurrent callers onto
 * one in-flight request -- confirmed live this mattered: the Translate
 * page's mount effect calls getPages() and getPageFolders() in the same
 * Promise.all, and getPageFolders() independently re-fetches this same
 * list internally, so every page load used to fire two near-simultaneous
 * requests for identical data), so this is just a filter, no fetch of its
 * own.
 */
async function listStaticPages() {
  const pages = await listPages();
  return pages.filter((p) => !p.collectionId);
}

// Sentinel for pages with a null `parentId` (not nested in any folder) --
// selectable in the folder picker like a normal folder, so top-level pages
// aren't silently unreachable by a Pages automation.
const NO_FOLDER_ID = "__root__";

/**
 * A page id also answers via GET /pages/:id even when that id is actually a
 * FOLDER, not a real page (confirmed live) -- Webflow has no dedicated
 * folder-listing endpoint, so folder metadata (title/slug) is resolved this
 * way, one call per distinct folder id referenced by some page's `parentId`.
 */
async function getPageFolder(folderId) {
  const { data } = await (await client()).get(`/pages/${folderId}`);
  return data;
}

/**
 * Discovers every folder actually in use (confirmed live: `GET
 * /sites/:id/pages` never returns the folder objects themselves, only pages
 * that reference a folder id via a non-null `parentId`), resolves each
 * folder's title/slug, and counts how many static pages sit in it (or at
 * top level, under NO_FOLDER_ID). Used by the Automation wizard's Pages
 * scope picker.
 */
async function fetchPageFolders() {
  const pages = await listStaticPages();
  const folderIds = [...new Set(pages.map((p) => p.parentId).filter(Boolean))];
  const folders = await Promise.all(folderIds.map(getPageFolder));

  const pageCountByFolder = pages.reduce((acc, p) => {
    const key = p.parentId || NO_FOLDER_ID;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const result = folders.map((f) => ({
    id: f.id,
    title: f.title,
    slug: f.slug,
    pageCount: pageCountByFolder[f.id] || 0,
  }));

  if (pageCountByFolder[NO_FOLDER_ID]) {
    result.push({ id: NO_FOLDER_ID, title: "No folder (top-level pages)", slug: null, pageCount: pageCountByFolder[NO_FOLDER_ID] });
  }

  return result;
}
const listPageFolders = makeTtlCache(fetchPageFolders);

/**
 * Batch sibling of getPageFolder -- resolves every distinct folder id in
 * one Promise.all (same dedup-and-fetch shape as listPageFolders() above),
 * keyed by id for O(1) lookup per page. Returns the RAW getPageFolder()
 * object for each (not the {id,title,slug} projection listPageFolders()
 * builds) so callers can also see that folder's own `parentId` -- needed
 * by buildPagePreviewUrl below to detect a page nested 2+ folders deep.
 */
async function getPageFoldersByIds(folderIds) {
  const uniqueIds = [...new Set((folderIds || []).filter(Boolean))];
  const folders = await Promise.all(uniqueIds.map(getPageFolder));
  return new Map(folders.map((f) => [f.id, f]));
}

/**
 * Filters a page list down to those inside one of the given folder ids
 * (NO_FOLDER_ID matches pages with a null parentId). Shared by the
 * Automation wizard's live scope preview and automationScheduler's polling
 * scan, so both agree on exactly what a Pages automation's scope includes.
 */
function filterPagesByFolderScope(pages, pageFolderIds) {
  const scopeSet = new Set(pageFolderIds);
  return pages.filter((p) => scopeSet.has(p.parentId || NO_FOLDER_ID));
}

/**
 * Fetches a page's DOM content (a flat node tree, NOT field-keyed like CMS
 * items -- see webflowDom.js for text extraction). Paginated (confirmed
 * live: Webflow caps at up to 1000 nodes/call, though real pages tested
 * this session were well under that).
 *
 * IMPORTANT (confirmed live): requesting a SECONDARY locale only returns
 * nodes that already have a locale-specific override for that locale --
 * not the full tree. Always fetch the PRIMARY locale (or omit `locale`) to
 * get the complete set of translatable content; only use a secondary
 * locale here if you specifically want to see what's already overridden.
 */
async function getPageDom(pageId, { locale } = {}) {
  const localeId = await resolvePageLocaleId(locale);
  const limit = 100;
  let offset = 0;
  let nodes = [];

  while (true) {
    const { data } = await (await client()).get(`/pages/${pageId}/dom`, { params: { localeId, limit, offset } });
    const page = data?.nodes || [];
    nodes = nodes.concat(page);

    const total = data?.pagination?.total ?? nodes.length;
    offset += limit;
    if (nodes.length >= total || page.length === 0) break;
  }

  return nodes;
}

/**
 * Writes translated text back to specific nodes on a page, for one
 * secondary locale. Confirmed live: a brand-new node override CAN be
 * created this way even if that node has never had a locale-specific
 * override before (unlike CMS items, which require a Designer-created
 * locale variant first) -- this is NOT the same restrictive constraint.
 * Partial node lists are accepted; nodes not mentioned are left untouched.
 *
 * `nodeUpdates` shape (confirmed live, differs from what GET /dom returns):
 * `[{ nodeId, text: "<full html string>" }]` -- `nodeId` not `id`, and
 * `text` is a plain HTML string, not the `{html, text}` object GET returns.
 */
async function updatePageDom(pageId, locale, nodeUpdates) {
  const localeId = await resolvePageLocaleId(locale);
  if (await isPrimaryPageLocaleId(localeId)) {
    // Defensive client-side guard -- confirmed live that Webflow's server
    // also properly rejects this (400 "must be a valid secondary locale"),
    // so this isn't covering a real server-side gap, just failing faster
    // with a clearer, attributable error.
    throw new Error(`Refusing to write page content to the primary locale ("${locale}") -- only secondary locales are writable via the API.`);
  }
  const { data } = await (await client()).post(`/pages/${pageId}/dom`, { nodes: nodeUpdates }, { params: { localeId } });
  return data;
}

/**
 * Lists every reusable Component defined on the site (confirmed live: 43 on
 * the real site, one call). Each entry is identity-only (`{id, name,
 * description, group}`) -- no content, unlike CMS items' `fieldData`.
 */
async function fetchComponents() {
  const limit = 100;
  let offset = 0;
  let components = [];

  while (true) {
    const { data } = await (await client()).get(`/sites/${await siteId()}/components`, { params: { limit, offset } });
    const page = data?.components || [];
    components = components.concat(page);

    const total = data?.pagination?.total ?? components.length;
    offset += limit;
    if (components.length >= total || page.length === 0) break;
  }

  return components;
}
const listComponents = makeTtlCache(fetchComponents);

/**
 * Fetches a component's DOM content -- IMPORTANT (confirmed live): unlike
 * Pages' `/pages/:id/dom`, this is nested under `/sites/:site_id/...`; the
 * bare `/components/:id/dom` 404s. Node shape and pagination are otherwise
 * identical to `getPageDom` (same `{id, type, text:{html,text}}` shape,
 * same "secondary locale only returns already-overridden nodes" behavior --
 * always read the PRIMARY locale for the full translatable tree).
 */
async function getComponentDom(componentId, { locale } = {}) {
  const localeId = await resolvePageLocaleId(locale);
  const limit = 100;
  let offset = 0;
  let nodes = [];

  while (true) {
    const { data } = await (await client()).get(`/sites/${await siteId()}/components/${componentId}/dom`, { params: { localeId, limit, offset } });
    const page = data?.nodes || [];
    nodes = nodes.concat(page);

    const total = data?.pagination?.total ?? nodes.length;
    offset += limit;
    if (nodes.length >= total || page.length === 0) break;
  }

  return nodes;
}

/**
 * Writes translated text back to specific nodes on a component's
 * *definition* -- propagates everywhere that component is used across the
 * site. Confirmed live (same contract as updatePageDom): reuses
 * `resolvePageLocaleId`/`isPrimaryPageLocaleId` (Components use the exact
 * same site-locale `id` scheme as Pages, NOT CMS items' `cmsLocaleId` --
 * verified live), same write payload shape, same hard 400 on a
 * primary-locale write.
 */
async function updateComponentDom(componentId, locale, nodeUpdates) {
  const localeId = await resolvePageLocaleId(locale);
  if (await isPrimaryPageLocaleId(localeId)) {
    throw new Error(`Refusing to write component content to the primary locale ("${locale}") -- only secondary locales are writable via the API.`);
  }
  const { data } = await (await client()).post(`/sites/${await siteId()}/components/${componentId}/dom`, { nodes: nodeUpdates }, { params: { localeId } });
  return data;
}

/**
 * Fetches a component definition's own Component Properties (Plain Text,
 * Rich Text, Alt Text, etc.) -- a channel entirely separate from the
 * component's own DOM nodes (confirmed live: zero overlap between
 * getComponentDom's node list and this endpoint's properties for the same
 * component -- some components are pure DOM text, some are pure
 * properties, some mix both). Same pagination/locale contract as
 * getComponentDom: always read the PRIMARY locale for the full set of
 * default values -- a secondary locale here would only return whatever's
 * already been translated.
 */
async function getComponentProperties(componentId, { locale } = {}) {
  const localeId = await resolvePageLocaleId(locale);
  const limit = 100;
  let offset = 0;
  let properties = [];

  while (true) {
    const { data } = await (await client()).get(`/sites/${await siteId()}/components/${componentId}/properties`, { params: { localeId, limit, offset } });
    const page = data?.properties || [];
    properties = properties.concat(page);

    const total = data?.pagination?.total ?? properties.length;
    offset += limit;
    if (properties.length >= total || page.length === 0) break;
  }

  return properties;
}

/**
 * Writes translated values back to a component definition's own default
 * property values, for one secondary locale -- propagates to every
 * placement of that component that doesn't itself override that property.
 * Same primary-locale-write guard as updateComponentDom.
 */
async function updateComponentProperties(componentId, locale, propertyUpdates) {
  const localeId = await resolvePageLocaleId(locale);
  if (await isPrimaryPageLocaleId(localeId)) {
    throw new Error(`Refusing to write component properties to the primary locale ("${locale}") -- only secondary locales are writable via the API.`);
  }
  const { data } = await (await client()).post(`/sites/${await siteId()}/components/${componentId}/properties`, { properties: propertyUpdates }, { params: { localeId } });
  return data;
}

/**
 * Fetches exactly one page of a collection's items (Webflow caps each page
 * at 100). Exposed as its own function -- not just an implementation
 * detail of listAllItems below -- so a caller that wants to show real,
 * incremental progress across a large collection (e.g. the Translate
 * page's "All content" item-count aggregate) can drive the pagination
 * loop itself instead of waiting for every page to be fetched server-side
 * before anything comes back at all.
 */
async function listItemsPage(collectionId, { locale, limit = 100, offset = 0 } = {}) {
  const cmsLocaleId = await resolveCmsLocaleId(locale);
  const { data } = await (await client()).get(`/collections/${collectionId}/items`, {
    params: { cmsLocaleId, limit, offset },
  });
  const items = data?.items || [];
  const total = data?.pagination?.total ?? items.length;
  return { items, total };
}

/**
 * Fetch all items in a collection for a given locale, handling pagination
 * (Webflow caps each page at 100 items).
 */
async function listAllItems(collectionId, { locale } = {}) {
  const limit = 100;
  let offset = 0;
  let items = [];

  while (true) {
    const { items: page, total } = await listItemsPage(collectionId, { locale, limit, offset });
    items = items.concat(page);
    offset += limit;
    if (items.length >= total || page.length === 0) break;
  }

  return items;
}

async function getItem(collectionId, itemId, { locale } = {}) {
  const cmsLocaleId = await resolveCmsLocaleId(locale);
  const { data } = await (await client()).get(`/collections/${collectionId}/items/${itemId}`, {
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
  const { data } = await (await client()).patch(`/collections/${collectionId}/items`, {
    items: [{ id: itemId, cmsLocaleId, fieldData }],
  });
  return data;
}

async function publishItems(collectionId, itemIds) {
  const { data } = await (await client()).post(`/collections/${collectionId}/items/publish`, {
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
      // Reference/MultiReference fields link to an item (or items) in
      // ANOTHER collection (e.g. a blog post's "Author" or "Tags") --
      // confirmed live against a real site's field schema that Webflow
      // puts that linked collection's id at validations.collectionId.
      // Only sent for these two types so callers can tell a Reference
      // field apart from a plain field without a linked collection.
      ...(["Reference", "MultiReference"].includes(f.type) && f.validations?.collectionId
        ? { linkedCollectionId: f.validations.collectionId }
        : {}),
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

// Webflow's real slug validation rule (confirmed live -- see
// filterTranslatableFields's comment above for the incident this guards
// against). Any slug this app ever writes must pass this before being sent.
const WEBFLOW_SLUG_REGEX = /^[_a-zA-Z0-9][-_a-zA-Z0-9]*$/;

// Compact Cyrillic/Greek -> Latin phonetic map for slugHandling's
// "transliterate" mode. CJK/Arabic/Hebrew have no reasonable 1:1 phonetic
// mapping, so they're deliberately left out here -- sanitizeSlug's
// fallback-to-source-slug backstop covers those safely instead of emitting
// garbage. Longer multi-character sequences must be listed before any
// single-character sequence they contain, since transliterateToLatin
// matches greedily from the start of the map.
const TRANSLITERATION_MAP = {
  ж: "zh", ч: "ch", ш: "sh", щ: "shch", ю: "yu", я: "ya", й: "y", ь: "", ъ: "",
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", з: "z", и: "i",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "ts", ы: "y", э: "e",
  th: "th", ph: "ph", ch: "ch", ps: "ps",
  α: "a", β: "v", γ: "g", δ: "d", ε: "e", ζ: "z", η: "i", θ: "th", ι: "i",
  κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x", ο: "o", π: "p", ρ: "r", σ: "s",
  ς: "s", τ: "t", υ: "y", φ: "f", χ: "ch", ψ: "ps", ω: "o",
};

/**
 * Phonetically transliterates Cyrillic/Greek characters to Latin, passing
 * every other character through untouched (including Latin script with
 * diacritics, which sanitizeSlug's NFKD pass handles separately, and
 * scripts with no mapping here at all, e.g. CJK/Arabic/Hebrew).
 */
function transliterateToLatin(value) {
  const lower = String(value || "").toLowerCase();
  let result = "";
  for (const char of lower) {
    result += TRANSLITERATION_MAP[char] ?? char;
  }
  return result;
}

/**
 * Turns arbitrary text (typically a translated or transliterated item
 * name) into something Webflow's slug field will actually accept. Always
 * enforces dashes/lowercase/length regardless of mode -- this is a hard
 * rule, not a setting. Falls back to `fallback` (the item's own untouched,
 * already-valid source slug) whenever the result would be empty or still
 * fail Webflow's own validation regex, so a bad candidate can never block
 * or corrupt a real delivery (see the production incident documented on
 * filterTranslatableFields above).
 */
function sanitizeSlug(value, { maxLength = 60, transliterate = false, fallback = "" } = {}) {
  let s = transliterate ? transliterateToLatin(value) : String(value || "");
  s = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > maxLength) {
    const truncated = s.slice(0, maxLength);
    // Prefer not to cut mid-word: drop back to the last dash boundary if
    // there is one, otherwise keep the hard truncation.
    const lastDash = truncated.lastIndexOf("-");
    s = (lastDash > 0 ? truncated.slice(0, lastDash) : truncated).replace(/^-+|-+$/g, "");
  }
  return s && WEBFLOW_SLUG_REGEX.test(s) ? s : fallback || "";
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

const DEFAULT_PAGE_WORK_UNIT_NAME_PATTERN = "page-{page}";

/**
 * Sibling of buildResourceFileName for pages -- supports a {page} token
 * instead of {collection}/{entry}, since a page has neither.
 */
function buildPageResourceFileName(pattern, { page }) {
  const pageToken = page.slug || slugify(page.title || page.id);
  const name = (pattern || DEFAULT_PAGE_WORK_UNIT_NAME_PATTERN).replace(/{page}/g, pageToken);
  return `${name}.json`;
}

const DEFAULT_COMPONENT_WORK_UNIT_NAME_PATTERN = "component-{component}";

/**
 * Sibling of buildPageResourceFileName for components -- supports a
 * {component} token. Components have no `slug` field, only `name` (e.g.
 * "<Footer>", "Dark CTA"), so it's always slugified.
 */
function buildComponentResourceFileName(pattern, { component }) {
  const componentToken = slugify(component.name || component.id);
  const name = (pattern || DEFAULT_COMPONENT_WORK_UNIT_NAME_PATTERN).replace(/{component}/g, componentToken);
  return `${name}.json`;
}

/**
 * Finds the collection's own Collection Page template, if any -- among the
 * UNFILTERED page list (listPages(), not listStaticPages(), which
 * deliberately filters these out), the one whose `collectionId` matches. A
 * collection can have zero template pages (never bound to one in the
 * Designer). Pure lookup, not a fetch -- callers fetch `pages` via
 * listPages() once and reuse it, no extra Webflow call per collection/item.
 */
function findCollectionTemplatePage(pages, collectionId) {
  return pages.find((p) => p.collectionId === collectionId);
}

/**
 * The live URL a CMS item renders at. Takes the collection's real template
 * PAGE (see findCollectionTemplatePage), not the collection itself --
 * confirmed live a template page's own URL slug commonly does NOT match
 * the collection's own `slug` field (real site: collection slug
 * "blog-tags", template page slug "detail_blog-tags"), so guessing from
 * the collection alone was wrong. `subdirectory` (optional) is a secondary
 * locale's own URL prefix (see getSiteLocales' `subdirectory` field) --
 * omitted, this builds the primary-locale URL exactly as before. Returns
 * undefined -- never a guess -- if any ingredient is missing.
 */
function buildCmsItemPreviewUrl({ site, templatePage, item, subdirectory }) {
  const templateSlug = templatePage?.slug;
  const itemSlug = item?.fieldData?.slug;
  if (!site?.url || !templateSlug || !itemSlug) return undefined;
  const prefix = subdirectory ? `/${subdirectory}` : "";
  return `${site.url}${prefix}/${templateSlug}/${itemSlug}`;
}

/**
 * The live URL a static page renders at. Only knowable for a top-level
 * page or one exactly one folder deep -- getPageFolder() only ever
 * resolves one level, so a page nested 2+ folders deep can't be
 * determined from data this app fetches today. `folder` (if passed) must
 * be the RAW getPageFolder() object (see getPageFoldersByIds above), so
 * its own `parentId` is available to detect that deeper-nesting case and
 * return undefined instead of a guaranteed-wrong partial path.
 * `subdirectory` (optional): see buildCmsItemPreviewUrl above.
 *
 * The site's homepage is a special case (confirmed live): Webflow gives
 * it `slug: null` rather than an empty path segment, since it IS the site
 * root -- not a missing/unknowable slug the way it would be for any other
 * page. Only valid at the top level; a null slug on a page with a parent
 * isn't a shape Webflow actually produces.
 */
function buildPagePreviewUrl({ site, page, folder, subdirectory }) {
  if (!site?.url) return undefined;
  const prefix = subdirectory ? `/${subdirectory}` : "";
  if (!page?.slug) return !page?.parentId ? `${site.url}${prefix}` : undefined;
  if (!page.parentId) return `${site.url}${prefix}/${page.slug}`;
  if (folder && !folder.parentId && folder.slug) return `${site.url}${prefix}/${folder.slug}/${page.slug}`;
  return undefined;
}

/**
 * Webflow Designer deep link for a static page -- the fallback shown when
 * no real published URL is available (locale not enabled, or unresolvable
 * per buildPagePreviewUrl's own limits). Confirmed live against real
 * Designer usage (not Webflow's formal deep-linking doc, which only
 * documents the separate ?app=<client-id> App-extension handoff pattern).
 */
function buildPageDesignerUrl({ site, page, locale }) {
  if (!site?.shortName || !page?.id) return undefined;
  return `https://${site.shortName}.design.webflow.com?${new URLSearchParams({ locale, pageId: page.id })}`;
}

/**
 * Sibling of buildPageDesignerUrl for a CMS item. `templatePage` must be
 * the collection's own template page (see findCollectionTemplatePage) --
 * the Designer's `pageId` param picks which Collection Page template to
 * open the canvas on; `itemId` + `workflow=canvas` select which item's
 * content loads into it.
 */
function buildCmsItemDesignerUrl({ site, templatePage, item, locale }) {
  if (!site?.shortName || !templatePage?.id || !item?.id) return undefined;
  return `https://${site.shortName}.design.webflow.com?${new URLSearchParams({
    locale,
    pageId: templatePage.id,
    itemId: item.id,
    workflow: "canvas",
  })}`;
}

module.exports = {
  listCollections,
  getCollection,
  getSiteLocales,
  listAllItems,
  listItemsPage,
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
  listPages,
  listStaticPages,
  getPageDom,
  updatePageDom,
  buildPageResourceFileName,
  DEFAULT_PAGE_WORK_UNIT_NAME_PATTERN,
  NO_FOLDER_ID,
  getPageFolder,
  getPageFoldersByIds,
  listPageFolders,
  filterPagesByFolderScope,
  listComponents,
  getComponentDom,
  updateComponentDom,
  getComponentProperties,
  updateComponentProperties,
  buildComponentResourceFileName,
  DEFAULT_COMPONENT_WORK_UNIT_NAME_PATTERN,
  findCollectionTemplatePage,
  buildCmsItemPreviewUrl,
  buildPagePreviewUrl,
  buildPageDesignerUrl,
  buildCmsItemDesignerUrl,
  sanitizeSlug,
  transliterateToLatin,
  WEBFLOW_SLUG_REGEX,
};
