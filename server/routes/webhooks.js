const express = require("express");
const webflow = require("../services/webflow");
const wxrks = require("../services/wxrks");
const store = require("../store");

const router = express.Router();

/**
 * POST /api/webhooks/wxrks
 * Fired by wxrks when a project finishes translation ("Project Translation
 * Finished"). A project is a whole sync batch (Full Sync run or a multi-item
 * Item Sync selection), so this fetches translated content for every item in
 * the batch and pushes each one back to its matching Webflow CMS item, per
 * target locale.
 *
 * Expected payload shape (per wxrks docs): { event, project: { uuid } }
 */
router.post("/wxrks", async (req, res) => {
  // TEMPORARY: capture the raw payload for every event type so we can see
  // real shapes (e.g. "Work Unit Translation File Ready") before building
  // handling for them. Remove once the per-work-unit handler is written.
  await store.setDebugWebhookPayload({ headers: req.headers, body: req.body }).catch(() => {});
  console.log("wxrks webhook payload:", JSON.stringify(req.body, null, 2));

  const event = req.body?.event;
  const wxrksProjectUUID = req.body?.project?.uuid || req.body?.projectUuid;

  if (event !== "Project Translation Finished") {
    return res.status(200).json({ ignored: true, reason: `unhandled event: ${event}` });
  }
  if (!wxrksProjectUUID) {
    return res.status(400).json({ error: "Missing project UUID in webhook payload" });
  }

  const mapping = await store.getProjectMapping(wxrksProjectUUID);
  if (!mapping) {
    return res.status(404).json({ error: `No mapping found for wxrks project ${wxrksProjectUUID}` });
  }

  try {
    const { autoPublish } = await store.getSettings();
    const { targetLocales, items } = mapping;

    const resultsByItem = [];

    for (const batchItem of items) {
      const { webflowCollectionId, webflowItemId, resourceId, fieldKeys } = batchItem;
      const resultsByLocale = [];

      for (const locale of targetLocales) {
        try {
          const translation = await wxrks.downloadResourceTranslation(wxrksProjectUUID, resourceId, locale);

          const fieldData = {};
          for (const fieldKey of fieldKeys) {
            const value = translation?.[fieldKey];
            if (value !== undefined) {
              fieldData[fieldKey] = value;
            }
          }

          if (Object.keys(fieldData).length === 0) continue;

          await webflow.patchItemLocale(webflowCollectionId, webflowItemId, locale, fieldData);

          if (autoPublish) {
            await webflow.publishItems(webflowCollectionId, [webflowItemId]);
          }

          resultsByLocale.push({ locale, fieldsUpdated: Object.keys(fieldData).length, published: autoPublish });
        } catch (err) {
          // One locale/resource not being ready yet (e.g. wxrks fires the
          // webhook before every work unit is truly done) shouldn't abort
          // the whole batch -- record it and keep going.
          resultsByLocale.push({ locale, error: err.response?.data?.message || err.message });
        }
      }

      resultsByItem.push({ webflowCollectionId, webflowItemId, resultsByLocale });
    }

    const itemsUpdated = resultsByItem.filter((r) => r.resultsByLocale.some((l) => l.fieldsUpdated > 0));
    const wordCount = itemsUpdated.reduce((sum, r) => {
      const originalItem = items.find((i) => i.webflowItemId === r.webflowItemId);
      return sum + (originalItem?.wordCount || 0);
    }, 0);

    await store.addWebflowUpdateToProjectMapping(wxrksProjectUUID, {
      targetLocales,
      itemsUpdated: itemsUpdated.length,
      wordCount,
      autoPublish,
      resultsByItem,
    });
    await store.updateProjectMapping(wxrksProjectUUID, { status: "completed" });

    res.json({ wxrksProjectUUID, resultsByItem });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// TEMPORARY: inspect the most recent raw webhook payload wxrks actually
// sent, to design real handling for event types beyond "Project Translation
// Finished". Remove once done.
router.get("/wxrks/debug-last", async (req, res) => {
  try {
    const payload = await store.getDebugWebhookPayload();
    res.json(payload || { message: "No webhook received yet" });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
