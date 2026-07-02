const express = require("express");
const webflow = require("../services/webflow");
const wxrks = require("../services/wxrks");
const store = require("../store");
const autoSyncSelfWrites = require("../services/autoSyncSelfWrites");
const autoSyncWebhook = require("../services/autoSyncWebhook");
const { evaluateAutoSyncRules } = require("../services/autoSyncRules");
const autoSyncQueue = require("../services/autoSyncQueue");

const router = express.Router();

/**
 * POST /api/webhooks/wxrks
 * Fired by wxrks on various events. We act on "WORK_UNIT_STATUS_CHANGE"
 * transitioning to "DELIVERED" -- fired per work unit (one Webflow item, one
 * target locale) as soon as that translation is ready, rather than waiting
 * for the whole project/batch to finish. That single work unit's translated
 * content is fetched and pushed straight to its matching Webflow CMS item.
 *
 * Real payload shape (confirmed via live webhook capture, not wxrks docs):
 *   {
 *     id, event_type: "WORK_UNIT_STATUS_CHANGE", new_status: "DELIVERED",
 *     previous_status: "TRANSLATED", project_uuid, org_unit_uuid,
 *     project_file_id, project_file_name, source_locale, target_locale,
 *     is_last_workflow, ...
 *   }
 * Note: `project_file_id` is NOT the same id as the `resourceId` returned by
 * our own resource-creation call (confirmed against the real
 * `/project/:uuid/resource/simple` list) -- match on `project_file_name`
 * instead, since we control that filename ourselves at upload time.
 * The top-level `id` field is the *work unit* uuid (confirmed against
 * `/project/:uuid/work-unit`), which is what
 * `/project/:uuid/work-unit/:workUnitUuid/translation` needs to return a
 * presigned translatedFileUrl -- the reliable per-work-unit retrieval path
 * (see wxrks.waitForWorkUnitTranslation). An earlier attempt using
 * `/project/:uuid/download?resources=...&locales=...` intermittently
 * returned an empty ZIP right after DELIVERED fired; that endpoint is for
 * ad-hoc bulk downloads, not this signal.
 * wxrks also POSTs a one-time { event_type: "WEBHOOK_VALIDATION" } ping when
 * a webhook is registered, expecting a 200 back to activate it.
 */
router.post("/wxrks", async (req, res) => {
  // TEMPORARY: capture the raw payload for every event type so we can see
  // real shapes before building handling for them. Remove once the
  // per-work-unit handler above is proven out.
  await store.setDebugWebhookPayload({ headers: req.headers, body: req.body }).catch(() => {});
  console.log("wxrks webhook payload:", JSON.stringify(req.body, null, 2));

  const {
    id: workUnitUuid,
    event_type: eventType,
    new_status: newStatus,
    project_uuid: wxrksProjectUUID,
    project_file_name: fileName,
    target_locale: locale,
  } = req.body || {};

  if (eventType === "WEBHOOK_VALIDATION") {
    return res.status(200).json({ ok: true });
  }
  if (eventType !== "WORK_UNIT_STATUS_CHANGE" || newStatus !== "DELIVERED") {
    return res.status(200).json({ ignored: true, reason: `unhandled event: ${eventType}${newStatus ? ` (${newStatus})` : ""}` });
  }
  if (!wxrksProjectUUID || !fileName || !locale || !workUnitUuid) {
    return res
      .status(400)
      .json({ error: "Missing id, project_uuid, project_file_name, or target_locale in webhook payload" });
  }

  const mapping = await store.getProjectMapping(wxrksProjectUUID);
  if (!mapping) {
    return res.status(404).json({ error: `No mapping found for wxrks project ${wxrksProjectUUID}` });
  }

  const batchItem = mapping.items.find((i) => i.resourceFileName === fileName);
  if (!batchItem) {
    return res.status(404).json({ error: `No item found for file ${fileName} in project ${wxrksProjectUUID}` });
  }

  const { webflowCollectionId, webflowItemId, fieldKeys, wordCount } = batchItem;

  try {
    const { autoPublish } = await store.getSettings();
    const translation = await wxrks.waitForWorkUnitTranslation(wxrksProjectUUID, workUnitUuid);

    const fieldData = {};
    for (const fieldKey of fieldKeys) {
      const value = translation?.[fieldKey];
      if (value !== undefined) fieldData[fieldKey] = value;
    }

    let resultsByLocale;
    if (Object.keys(fieldData).length === 0) {
      resultsByLocale = [{ locale, error: "Downloaded translation had no matching fields" }];
    } else {
      await webflow.patchItemLocale(webflowCollectionId, webflowItemId, locale, fieldData);
      // Auto Sync loop-prevention: a live test proved the inbound Webflow
      // webhook's cmsLocaleId can't tell us which locale this write landed
      // on, so instead we mark that we JUST wrote this item at all -- the
      // Auto Sync webhook checks this before reacting to any
      // collection_item_changed/published event for the same item.
      autoSyncSelfWrites.markSelfWrite(webflowCollectionId, webflowItemId);
      if (autoPublish) {
        await webflow.publishItems(webflowCollectionId, [webflowItemId]);
      }
      resultsByLocale = [{ locale, fieldsUpdated: Object.keys(fieldData).length, published: autoPublish }];
    }

    const fieldsUpdated = resultsByLocale[0].fieldsUpdated || 0;
    const updatedMapping = await store.addWebflowUpdateToProjectMapping(wxrksProjectUUID, {
      targetLocales: [locale],
      itemsUpdated: fieldsUpdated > 0 ? 1 : 0,
      wordCount: fieldsUpdated > 0 ? wordCount : 0,
      autoPublish,
      resultsByItem: [{ webflowCollectionId, webflowItemId, resultsByLocale }],
    });

    // wxrks fires this per (work unit, locale) rather than once for the
    // whole batch, so there's no single "project done" signal to key off --
    // instead mark the batch completed once every (item, locale) pair has a
    // recorded delivery.
    const expectedPairs = mapping.items.length * mapping.targetLocales.length;
    const deliveredPairs = new Set(
      updatedMapping.updates.flatMap((u) =>
        (u.resultsByItem || []).flatMap((r) => u.targetLocales.map((l) => `${r.webflowItemId}:${l}`))
      )
    ).size;
    if (deliveredPairs >= expectedPairs) {
      await store.updateProjectMapping(wxrksProjectUUID, { status: "completed" });
    }

    res.json({ wxrksProjectUUID, workUnitUuid, resultsByLocale });
  } catch (err) {
    res.status(502).json({ error: err.response?.data?.message || err.message });
  }
});

/**
 * POST /api/webhooks/webflow
 * Fired by Webflow on "collection_item_published". Live-verified payload
 * shape: { payload: { id, siteId, workspaceId, collectionId, cmsLocaleId,
 * isDraft, isArchived, lastPublished, lastUpdated, createdOn, fieldData },
 * triggerType }.
 *
 * IMPORTANT: `cmsLocaleId` does NOT reliably indicate which locale was
 * edited (live-tested: it reports the primary locale's id even when only a
 * secondary locale's field changed) -- do not use it for loop-prevention.
 * Instead this route checks autoSyncSelfWrites (a blanket per-item cooldown
 * marked by the /wxrks handler above whenever it pushes a translation back),
 * and always re-fetches the item fresh via the primary locale rather than
 * trusting payload.fieldData for content.
 */
router.post("/webflow", async (req, res) => {
  const settings = await store.getSettings();
  const { signingSecret } = settings.autoSync.webhook;

  const verified = autoSyncWebhook.verifySignature({
    rawBody: req.rawBody,
    signature: req.headers["x-webflow-signature"],
    timestamp: req.headers["x-webflow-timestamp"],
    signingSecret,
  });
  if (!verified) {
    return res.status(401).json({ error: "Invalid or missing Webflow webhook signature" });
  }

  // Liveness signal for reconciliation's deactivation inference -- recorded
  // for any verified request, regardless of whether it ends up qualifying.
  await store.updateAutoSyncWebhookState({ lastEventAt: new Date().toISOString() });

  if (!settings.autoSync.enabled) {
    return res.status(200).json({ ignored: true, reason: "Auto Sync is disabled" });
  }

  const { payload, triggerType } = req.body || {};
  if (triggerType !== autoSyncWebhook.TRIGGER_TYPE || !payload) {
    return res.status(200).json({ ignored: true, reason: `unhandled trigger: ${triggerType}` });
  }

  const { id: itemId, collectionId, isDraft, isArchived } = payload;
  if (isDraft || isArchived) {
    return res.status(200).json({ ignored: true, reason: "draft or archived" });
  }
  if (autoSyncSelfWrites.isRecentSelfWrite(collectionId, itemId)) {
    return res.status(200).json({ ignored: true, reason: "recent self-write (translation push-back echo)" });
  }

  try {
    const collection = await webflow.getCollection(collectionId);
    const locales = await webflow.getSiteLocales();
    // Always re-fetch fresh primary-locale content rather than trusting
    // payload.fieldData -- decouples correctness from cmsLocaleId entirely.
    const item = await webflow.getItem(collectionId, itemId, { locale: locales.primary.tag });

    const qualifies = evaluateAutoSyncRules(settings, collection, item);
    if (qualifies) {
      autoSyncQueue.enqueue({ collection, item });
    }

    res.json({ received: true, qualified: qualifies });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// TEMPORARY: inspect recent raw webhook payloads wxrks actually sent, to
// design real handling for event types beyond "Project Translation
// Finished". Returns a list (most recent first) since a single-slot capture
// was getting overwritten by validation pings before we could inspect real
// events. Remove once done.
router.get("/wxrks/debug-last", async (req, res) => {
  try {
    const history = await store.getDebugWebhookPayload();
    res.json(history.length > 0 ? { history } : { message: "No webhook received yet" });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
