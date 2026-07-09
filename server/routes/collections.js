const express = require("express");
const webflow = require("../services/webflow");
const store = require("../store");

const router = express.Router();

/**
 * GET /api/collections
 * List all Webflow CMS collections for the configured site.
 */
router.get("/", async (req, res) => {
  try {
    const collections = await webflow.listCollections();
    res.json({ collections });
  } catch (err) {
    res.status(502).json({ error: err.response?.data?.message || err.message });
  }
});

/**
 * GET /api/collections/fields-summary
 * Account-wide rollup of the field-exclusion / auto-translate config, for
 * the Dashboard's setup checklist. Schema-only (one webflow.getCollection
 * call per collection, no item fetches) so it stays cheap regardless of
 * collection size -- unlike the removed backlog scan this replaces context
 * for on the Dashboard.
 */
router.get("/fields-summary", async (req, res) => {
  try {
    const collections = await webflow.listCollections();
    let totalTranslatableFields = 0;
    let excludedFieldCount = 0;
    let collectionsWithExclusions = 0;

    for (const c of collections) {
      const [collection, exclusions] = await Promise.all([
        webflow.getCollection(c.id),
        store.getFieldExclusions(req.account.id, c.id),
      ]);
      const schema = webflow.listFieldSchema(collection);
      const translatable = schema.filter((f) => f.translatableByDefault);
      const excluded = translatable.filter((f) => exclusions.includes(f.slug));
      totalTranslatableFields += translatable.length;
      excludedFieldCount += excluded.length;
      if (excluded.length > 0) collectionsWithExclusions += 1;
    }

    res.json({ collectionCount: collections.length, totalTranslatableFields, excludedFieldCount, collectionsWithExclusions });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/collections/:id/fields
 * The collection's real field schema (type + translatable-by-default),
 * merged with any user-configured exclusions, for the field-exclusion UI.
 */
router.get("/:id/fields", async (req, res) => {
  try {
    const [collection, exclusions] = await Promise.all([
      webflow.getCollection(req.params.id),
      store.getFieldExclusions(req.account.id, req.params.id),
    ]);
    const schema = webflow.listFieldSchema(collection);
    const excluded = new Set(exclusions);

    res.json({
      fields: schema.map((f) => ({
        ...f,
        excluded: excluded.has(f.slug) || !f.translatableByDefault,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * PUT /api/collections/:id/field-exclusions
 * body: { excludedFields: string[] }
 * Explicit field-slug overrides on top of the automatic type-based filter
 * (e.g. to exclude a PlainText field that shouldn't be translated).
 */
router.put("/:id/field-exclusions", async (req, res) => {
  try {
    const { excludedFields } = req.body || {};
    const updated = await store.setFieldExclusions(req.account.id, req.params.id, excludedFields || []);
    res.json({ collectionId: req.params.id, excludedFields: updated });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/collections/:id/items
 * List items with translation status per configured target locale, plus
 * each item's translatable word count (same field-filtering logic
 * syncCore.js uses, computed for free since fieldData is already fetched).
 * Status per locale: "published" (translated) | "draft" (pending) | "missing".
 */
router.get("/:id/items", async (req, res) => {
  const { id } = req.params;

  try {
    const [{ sourceLocale, targetLocales }, collection, exclusions] = await Promise.all([
      store.getSettings(req.account.id),
      webflow.getCollection(id),
      store.getFieldExclusions(req.account.id, id),
    ]);
    const sourceItems = await webflow.listAllItems(id, { locale: sourceLocale });

    const localeItemLists = await Promise.all(
      targetLocales.map((locale) => webflow.listAllItems(id, { locale }))
    );

    // fieldData is already in memory from listAllItems above -- computing
    // word count here is free (no extra Webflow calls), unlike Pages/
    // Components' list endpoints where it would mean a DOM fetch per row.
    const fieldTypeBySlug = webflow.getFieldTypeMap(collection);
    const deliveryStatus = await store.getDeliveryStatusByEntity(req.account.id, "webflowItemId");

    const items = sourceItems.map((sourceItem) => {
      const localeStatus = {};
      const localeErrors = {};
      targetLocales.forEach((locale, idx) => {
        const localeItem = localeItemLists[idx].find((it) => it.id === sourceItem.id);
        const { status, error } = store.computeLocaleStatus({
          delivery: deliveryStatus[sourceItem.id]?.[locale],
          sourceLastUpdated: sourceItem.lastPublished,
          localeExists: Boolean(localeItem),
          localeIsDraft: localeItem?.isDraft,
        });
        localeStatus[locale] = status;
        if (error) localeErrors[locale] = error;
      });

      // Item-level aggregate, used for the Status column and the "needs
      // sync"/"failed" filters: any locale failed -> failed; every locale
      // synced -> synced; every locale never delivered -> new; anything
      // else (partial/mixed) -> stale.
      const localeStates = Object.values(localeStatus);
      const state = localeStates.includes("failed")
        ? "failed"
        : localeStates.every((s) => s === "synced")
        ? "synced"
        : localeStates.every((s) => s === "new")
        ? "new"
        : "stale";

      const translatableFields = webflow.filterTranslatableFields(sourceItem.fieldData, fieldTypeBySlug, exclusions);

      return {
        id: sourceItem.id,
        name: sourceItem.fieldData?.name || sourceItem.fieldData?.slug || sourceItem.id,
        lastUpdated: sourceItem.lastUpdated,
        lastPublished: sourceItem.lastPublished,
        isArchived: sourceItem.isArchived,
        isDraft: sourceItem.isDraft,
        state,
        localeStatus,
        localeErrors,
        wordCount: webflow.countWords(translatableFields),
        // Raw field values, already in memory from listAllItems above (zero
        // extra Webflow calls) -- lets Translate's top-level filter builder
        // filter by any real field client-side without a second round trip.
        fieldData: sourceItem.fieldData,
      };
    });

    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/collections/:id/items-summary?offset=&limit=
 * Lightweight version of GET /:id/items for the Translate page's "All
 * content" aggregate, which only ever needs each item's id + word count --
 * unlike the full endpoint, this skips fetching every target locale's item
 * list entirely (1 + targetLocales.length real Webflow calls there, vs
 * just 1 here), since per-locale delivery status isn't used by the
 * aggregate view at all. Confirmed live: for an 11-collection, 10-locale
 * site this cuts ~121 Webflow calls down to ~11 for the same aggregate.
 *
 * Paginated (one real Webflow page per call, via webflow.listItemsPage)
 * rather than fetching the whole collection server-side before responding
 * -- lets the client show real, incrementally-growing item-count progress
 * even mid-way through one large collection, instead of that collection's
 * whole contribution to the total arriving in one lump the moment it
 * finally finishes.
 */
router.get("/:id/items-summary", async (req, res) => {
  const { id } = req.params;
  const limit = 100;
  const offset = Number(req.query.offset) || 0;
  try {
    const [{ sourceLocale }, collection, exclusions] = await Promise.all([
      store.getSettings(req.account.id),
      webflow.getCollection(id),
      store.getFieldExclusions(req.account.id, id),
    ]);
    const { items: pageItems, total } = await webflow.listItemsPage(id, { locale: sourceLocale, limit, offset });
    const fieldTypeBySlug = webflow.getFieldTypeMap(collection);

    const items = pageItems.map((sourceItem) => {
      const translatableFields = webflow.filterTranslatableFields(sourceItem.fieldData, fieldTypeBySlug, exclusions);
      return { id: sourceItem.id, wordCount: webflow.countWords(translatableFields) };
    });

    res.json({ items, total, offset, limit });
  } catch (err) {
    res.status(502).json({ error: err.response?.data?.message || err.message });
  }
});

/**
 * Shared handler for GET /api/backlog — all non-source-locale items that are
 * still Draft (= untranslated), across every collection. Scoped by Webflow's
 * own configured site locales, not by settings -- there's no per-collection
 * enable/disable concept here, every collection is scanned.
 */
async function backlogHandler(req, res) {
  try {
    const collections = await webflow.listCollections();
    const { primary, secondary } = await webflow.getSiteLocales();
    const sourceLocale = primary.tag;
    const targetLocales = secondary.map((l) => l.tag);
    const backlog = [];

    for (const collection of collections) {
      const sourceItems = await webflow.listAllItems(collection.id, { locale: sourceLocale });

      for (const locale of targetLocales) {
        const localeItems = await webflow.listAllItems(collection.id, { locale });

        for (const sourceItem of sourceItems) {
          const localeItem = localeItems.find((it) => it.id === sourceItem.id);
          const isUntranslated = !localeItem || localeItem.isDraft;
          if (isUntranslated) {
            backlog.push({
              collectionId: collection.id,
              collectionName: collection.displayName || collection.singularName,
              itemId: sourceItem.id,
              itemName: sourceItem.fieldData?.name || sourceItem.fieldData?.slug || sourceItem.id,
              locale,
              lastUpdated: sourceItem.lastUpdated,
            });
          }
        }
      }
    }

    res.json({ backlog, count: backlog.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}

module.exports = router;
module.exports.backlogHandler = backlogHandler;
