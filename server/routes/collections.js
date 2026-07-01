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
    const [collections, settings] = await Promise.all([webflow.listCollections(), store.getSettings()]);
    res.json({
      collections: collections.map((c) => ({
        ...c,
        enabled: store.isCollectionEnabled(settings, c.id),
      })),
    });
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
      store.getFieldExclusions(req.params.id),
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
    const updated = await store.setFieldExclusions(req.params.id, excludedFields || []);
    res.json({ collectionId: req.params.id, excludedFields: updated });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/collections/:id/items
 * List items with translation status per configured target locale.
 * Status per locale: "published" (translated) | "draft" (pending) | "missing".
 */
router.get("/:id/items", async (req, res) => {
  const { id } = req.params;

  try {
    const { sourceLocale, targetLocales } = await store.getSettings();
    const sourceItems = await webflow.listAllItems(id, { locale: sourceLocale });

    const localeItemLists = await Promise.all(
      targetLocales.map((locale) => webflow.listAllItems(id, { locale }))
    );

    const items = sourceItems.map((sourceItem) => {
      const localeStatus = {};
      targetLocales.forEach((locale, idx) => {
        const localeItem = localeItemLists[idx].find((it) => it.id === sourceItem.id);
        if (!localeItem) {
          localeStatus[locale] = "missing";
        } else {
          localeStatus[locale] = localeItem.isDraft ? "draft" : "published";
        }
      });

      return {
        id: sourceItem.id,
        name: sourceItem.fieldData?.name || sourceItem.fieldData?.slug || sourceItem.id,
        lastUpdated: sourceItem.lastUpdated,
        lastPublished: sourceItem.lastPublished,
        isArchived: sourceItem.isArchived,
        isDraft: sourceItem.isDraft,
        localeStatus,
      };
    });

    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * Shared handler for GET /api/backlog — all non-source-locale items that are
 * still Draft (= untranslated), across every collection.
 */
async function backlogHandler(req, res) {
  try {
    const settings = await store.getSettings();
    const { sourceLocale, targetLocales } = settings;
    const allCollections = await webflow.listCollections();
    const collections = allCollections.filter((c) => store.isCollectionEnabled(settings, c.id));
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
