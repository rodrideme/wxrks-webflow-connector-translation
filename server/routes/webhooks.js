const express = require("express");
const webflow = require("../services/webflow");
const webflowDom = require("../services/webflowDom");
const wxrks = require("../services/wxrks");
const store = require("../store");
const autoSyncSelfWrites = require("../services/autoSyncSelfWrites");
const autoSyncWebhook = require("../services/autoSyncWebhook");
const autoSyncQueue = require("../services/autoSyncQueue");
const automationScheduler = require("../services/automationScheduler");

const router = express.Router();

/**
 * POST /api/webhooks/wxrks
 * Fired by wxrks on various events. We act on two of them, both meaning
 * "this work unit's translation is ready to push to Webflow":
 *  - "WORK_UNIT_TRANSLATION_FILE_READY": the reliable, preferred signal --
 *    its payload already includes a working `translated_file_url` (a
 *    presigned S3 link good for ~160 hours), confirmed live. No polling
 *    needed at all for this one.
 *  - "WORK_UNIT_STATUS_CHANGE" with new_status "DELIVERED": fires around the
 *    same time but does NOT carry a ready file URL -- falls back to
 *    wxrks.waitForWorkUnitTranslation's polling (see that function's docs).
 * Both webhooks are typically registered together and can both fire for the
 * same delivery, so this handler dedups against `mapping.updates` before
 * doing any work, keyed by (webflowItemId, locale).
 *
 * Not account-scoped by URL like the Webflow webhooks below -- wxrks has
 * one shared webhook regardless of account, and doesn't know about accounts
 * at all. Instead, the project mapping (looked up by the globally-unique
 * wxrks_project_uuid the payload already carries) tells us which account
 * this delivery belongs to.
 *
 * Real payload shape (confirmed via live webhook capture, not wxrks docs):
 *   {
 *     id, event_type, new_status?, project_uuid, org_unit_uuid,
 *     project_file_id, project_file_name, source_locale, target_locale,
 *     translated_file_url?, is_last_workflow, ...
 *   }
 * Note: `project_file_id` is NOT the same id as the `resourceId` returned by
 * our own resource-creation call (confirmed against the real
 * `/project/:uuid/resource/simple` list) -- match on `project_file_name`
 * instead, since we control that filename ourselves at upload time.
 * The top-level `id` field is the *work unit* uuid.
 * wxrks also POSTs a one-time { event_type: "WEBHOOK_VALIDATION" } ping when
 * a webhook is registered, expecting a 200 back to activate it.
 */
router.post("/wxrks", async (req, res) => {
  console.log("wxrks webhook payload:", JSON.stringify(req.body, null, 2));

  const {
    id: workUnitUuid,
    event_type: eventType,
    new_status: newStatus,
    project_uuid: wxrksProjectUUID,
    project_file_name: fileName,
    target_locale: locale,
    translated_file_url: directTranslatedFileUrl,
  } = req.body || {};

  if (eventType === "WEBHOOK_VALIDATION") {
    return res.status(200).json({ ok: true });
  }
  const isTranslationFileReady = eventType === "WORK_UNIT_TRANSLATION_FILE_READY";
  const isDeliveredStatusChange = eventType === "WORK_UNIT_STATUS_CHANGE" && newStatus === "DELIVERED";
  if (!isTranslationFileReady && !isDeliveredStatusChange) {
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
  // TEMPORARY: capture the raw payload for every event type so we can see
  // real shapes before building handling for them. Remove once the
  // per-work-unit handler above is proven out. Only possible once the
  // mapping resolves the account this delivery belongs to.
  await store.setDebugWebhookPayload(mapping.accountId, { headers: req.headers, body: req.body }).catch(() => {});

  const batchItem = mapping.items.find((i) => i.resourceFileName === fileName);
  if (!batchItem) {
    return res.status(404).json({ error: `No item found for file ${fileName} in project ${wxrksProjectUUID}` });
  }

  const {
    entityType = "cmsItem",
    webflowCollectionId,
    webflowItemId,
    webflowPageId,
    webflowComponentId,
    resourceId,
    fieldKeys,
    wordCount,
  } = batchItem;
  const isPage = entityType === "page";
  const isComponent = entityType === "component";

  // Dedup: WORK_UNIT_TRANSLATION_FILE_READY and WORK_UNIT_STATUS_CHANGE/
  // DELIVERED can both fire for the same delivery -- skip if this
  // (item, locale) already has a successful push recorded. Matches on
  // webflowPageId/webflowComponentId/webflowItemId depending on entity
  // type -- the three entity types never share a batch (see
  // project_mappings' `mode` values), so there's no risk of collision.
  const alreadyPushed = mapping.updates.some(
    (u) =>
      u.targetLocales.includes(locale) &&
      (u.resultsByItem || []).some(
        (r) =>
          (isComponent ? r.webflowComponentId === webflowComponentId : isPage ? r.webflowPageId === webflowPageId : r.webflowItemId === webflowItemId) &&
          (r.resultsByLocale || []).some((rl) => rl.locale === locale && rl.fieldsUpdated > 0)
      )
  );
  if (alreadyPushed) {
    return res.status(200).json({ ignored: true, reason: "already pushed to Webflow for this item/locale" });
  }

  // Respond immediately -- wxrks's own webhook client times out waiting for
  // a response (confirmed live: a real delivery failed with "request timed
  // out" from wxrks's Java HTTP client) if we make it wait on
  // waitForWorkUnitTranslation's retry/poll loop plus the actual network
  // calls. The real work happens after the response is sent, matching the
  // same "respond fast, process in background" pattern already used by the
  // /api/sync/bulk endpoint.
  res.json({ received: true, wxrksProjectUUID, workUnitUuid });

  (async () => {
    const { autoPublish } = await store.getSettings(mapping.accountId);
    const translation = directTranslatedFileUrl
      ? await wxrks.fetchTranslatedFile(directTranslatedFileUrl)
      : await wxrks.waitForWorkUnitTranslation(wxrksProjectUUID, workUnitUuid, resourceId, locale);

    const fieldData = {};
    for (const fieldKey of fieldKeys) {
      // "slug" must never be patched with translated free text -- Webflow
      // requires slugs to match `^[_a-zA-Z0-9][-_a-zA-Z0-9]*$` and rejects
      // the whole PATCH otherwise (confirmed live: this was silently
      // breaking every delivery for any item whose fieldKeys included
      // "slug", which filterTranslatableFields no longer sends to wxrks for
      // NEW syncs -- this guard covers batches uploaded before that fix).
      // N/A for pages/components (fieldKeys holds DOM node ids there, never "slug").
      if (entityType === "cmsItem" && fieldKey === "slug") continue;
      const value = translation?.[fieldKey];
      if (value !== undefined) fieldData[fieldKey] = value;
    }

    let resultsByLocale;
    if (Object.keys(fieldData).length === 0) {
      resultsByLocale = [{ locale, error: "Downloaded translation had no matching fields" }];
    } else if (isComponent) {
      try {
        await webflow.updateComponentDom(webflowComponentId, locale, webflowDom.buildNodeUpdates(fieldData));
        resultsByLocale = [{ locale, fieldsUpdated: Object.keys(fieldData).length }];
      } catch (err) {
        resultsByLocale = [{ locale, error: err.response?.data?.message || err.message }];
      }
    } else if (isPage) {
      try {
        await webflow.updatePageDom(webflowPageId, locale, webflowDom.buildNodeUpdates(fieldData));
        resultsByLocale = [{ locale, fieldsUpdated: Object.keys(fieldData).length }];
      } catch (err) {
        resultsByLocale = [{ locale, error: err.response?.data?.message || err.message }];
      }
    } else {
      try {
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
      } catch (err) {
        // Webflow cannot create a new locale variant for a pre-existing item
        // via the API at all (confirmed against Webflow's own docs) -- that
        // locale must be added once, manually, in the CMS Designer panel
        // before this PATCH can ever succeed for that item. Surface that
        // plainly instead of a generic 404, since it's an action the user
        // needs to take, not a bug to retry.
        const isMissingLocaleVariant = err.response?.status === 404;
        const message = isMissingLocaleVariant
          ? `This item has no "${locale}" locale variant in Webflow yet. Add "${locale}" to this item once in Webflow's CMS Designer (Collection settings > Localization), then it'll sync automatically going forward.`
          : err.response?.data?.message || err.message;
        resultsByLocale = [{ locale, error: message }];
      }
    }

    const fieldsUpdated = resultsByLocale[0].fieldsUpdated || 0;
    const resultEntry = isComponent
      ? { webflowComponentId, resultsByLocale }
      : isPage
      ? { webflowPageId, resultsByLocale }
      : { webflowCollectionId, webflowItemId, resultsByLocale };
    const updatedMapping = await store.addWebflowUpdateToProjectMapping(wxrksProjectUUID, {
      targetLocales: [locale],
      itemsUpdated: fieldsUpdated > 0 ? 1 : 0,
      wordCount: fieldsUpdated > 0 ? wordCount : 0,
      autoPublish,
      resultsByItem: [resultEntry],
    });

    // wxrks fires this per (work unit, locale) rather than once for the
    // whole batch, so there's no single "project done" signal to key off --
    // instead mark the batch completed once every (item, locale) pair has a
    // recorded delivery.
    const expectedPairs = mapping.items.length * mapping.targetLocales.length;
    const deliveredPairs = new Set(
      updatedMapping.updates.flatMap((u) =>
        (u.resultsByItem || []).flatMap((r) => u.targetLocales.map((l) => `${r.webflowComponentId || r.webflowPageId || r.webflowItemId}:${l}`))
      )
    ).size;
    if (deliveredPairs >= expectedPairs) {
      await store.updateProjectMapping(wxrksProjectUUID, { status: "completed" });
    }
  })().catch((err) => {
    console.error(
      `wxrks webhook background processing failed for project ${wxrksProjectUUID}, work unit ${workUnitUuid}:`,
      err.response?.data?.message || err.message
    );
  });
});

/**
 * Shared body of both account-scoped Webflow webhook routes below: verifies
 * the HMAC signature against exactly the account's own signing secret (read
 * from that account's settings), records liveness, and returns whether it's
 * valid. `settingsKey` is which of the account's two independent webhook
 * registrations ("autoSyncWebhook" for CMS, "sitePublishWebhook" for Pages/
 * Components) this delivery is for.
 */
async function verifyAccountWebhook(req, res, accountId, settingsKey, updateLastEventAt) {
  const settings = await store.getSettings(accountId);
  const verified = autoSyncWebhook.verifySignature({
    rawBody: req.rawBody,
    signature: req.headers["x-webflow-signature"],
    timestamp: req.headers["x-webflow-timestamp"],
    signingSecret: settings[settingsKey].signingSecret,
  });
  if (!verified) {
    res.status(401).json({ error: "Invalid or missing Webflow webhook signature" });
    return false;
  }
  await updateLastEventAt();
  return true;
}

/**
 * POST /api/webhooks/webflow/:accountId/site-publish
 * Pages/Components -- Webflow has no per-page or per-component webhook at
 * all, this ("site_publish", fires on any Designer publish action) is the
 * closest available signal, and its payload carries no account-identifying
 * field whatsoever -- the account id in this route's own URL (assigned at
 * registration time, see autoSyncWebhook.js) is the *only* way to resolve
 * which account a delivery belongs to. Handling it means re-running the
 * same scan automationScheduler's cadence tick would do, just triggered by
 * the publish instead of waiting for the schedule. Enqueues only (mirrors
 * the CMS route below) -- sending to wxrks still waits for the automation's
 * own cadence or a manual flush.
 */
router.post("/webflow/:accountId/site-publish", async (req, res) => {
  const { accountId } = req.params;
  const ok = await verifyAccountWebhook(req, res, accountId, "sitePublishWebhook", () =>
    store.updateSitePublishWebhookState(accountId, { lastEventAt: new Date().toISOString() })
  );
  if (!ok) return;

  // Respond immediately -- scanning can mean many Webflow API calls
  // (Components need a DOM fetch per component just to hash them), same
  // "respond fast, process after" pattern as the wxrks webhook above.
  res.json({ received: true });
  automationScheduler
    .scanAndEnqueueForPublishEvent(accountId)
    .catch((err) => console.error(`Pages/Components publish-triggered scan failed for account ${accountId}:`, err.message));
});

/**
 * POST /api/webhooks/webflow/:accountId/cms-item-published
 * Fired by Webflow on "collection_item_published". Live-verified payload
 * shape: { payload: { items: [ { id, siteId, workspaceId, collectionId,
 * cmsLocaleId, isDraft, isArchived, lastPublished, lastUpdated, createdOn,
 * fieldData }, ... ] }, triggerType } -- note the `items` ARRAY wrapper.
 * This differs from `collection_item_changed`'s flat single-item payload
 * (confirmed via an earlier live test of that trigger type only); Webflow
 * batches multiple items into one `collection_item_published` delivery when
 * several are published together (e.g. a bulk "Publish all" action), so
 * every item in the array must be processed, not just one.
 *
 * IMPORTANT: `cmsLocaleId` does NOT reliably indicate which locale was
 * edited (live-tested against `collection_item_changed`: it reports the
 * primary locale's id even when only a secondary locale's field changed) --
 * do not use it for loop-prevention. Instead this route checks
 * autoSyncSelfWrites (a blanket per-item cooldown marked by the /wxrks
 * handler above whenever it pushes a translation back), and always
 * re-fetches each item fresh via the primary locale rather than trusting
 * payload fieldData for content.
 */
router.post("/webflow/:accountId/cms-item-published", async (req, res) => {
  const { accountId } = req.params;
  const ok = await verifyAccountWebhook(req, res, accountId, "autoSyncWebhook", () =>
    store.updateAutoSyncWebhookState(accountId, { lastEventAt: new Date().toISOString() })
  );
  if (!ok) return;

  const automations = await store.listAutomations(accountId);
  const cmsAutomations = automations.filter(
    (a) =>
      a.enabled &&
      !a.archived &&
      (a.contentScope.scope === "all" || (a.contentScope.leaves || []).some((l) => l.kind === "collection"))
  );
  if (cmsAutomations.length === 0) {
    return res.status(200).json({ ignored: true, reason: "No enabled CMS/All Content automations" });
  }

  const { triggerType, payload } = req.body || {};
  const items = payload?.items;
  if (triggerType !== autoSyncWebhook.TRIGGER_TYPE || !Array.isArray(items)) {
    return res.status(200).json({ ignored: true, reason: `unhandled trigger: ${triggerType}` });
  }

  const results = [];
  for (const itemPayload of items) {
    const { id: itemId, collectionId, isDraft, isArchived } = itemPayload;
    if (isDraft || isArchived) {
      results.push({ itemId, qualified: false, reason: "draft or archived" });
      continue;
    }
    if (autoSyncSelfWrites.isRecentSelfWrite(collectionId, itemId)) {
      results.push({ itemId, qualified: false, reason: "recent self-write (translation push-back echo)" });
      continue;
    }

    try {
      const collection = await webflow.getCollection(collectionId);
      const locales = await webflow.getSiteLocales();
      // Always re-fetch fresh primary-locale content rather than trusting
      // payload.fieldData -- decouples correctness from cmsLocaleId entirely.
      const item = await webflow.getItem(collectionId, itemId, { locale: locales.primary.tag });

      const qualifyingAutomations = cmsAutomations.filter((a) =>
        store.isAutomationContentQualified(a, "collection", { leafId: collectionId, itemLike: item })
      );
      console.log(
        `Automation evaluation for ${collection.displayName || collectionId}/${itemId}: qualifies for ${qualifyingAutomations.length} automation(s)`
      );
      for (const automation of qualifyingAutomations) {
        autoSyncQueue.enqueue({ automation, collection, item });
      }
      results.push({ itemId, qualified: qualifyingAutomations.length > 0, automationIds: qualifyingAutomations.map((a) => a.id) });
    } catch (err) {
      results.push({ itemId, error: err.message });
    }
  }

  res.json({ received: true, results });
});

// TEMPORARY: inspect recent raw webhook payloads wxrks actually sent, to
// design real handling for event types beyond "Project Translation
// Finished". Returns a list (most recent first) since a single-slot capture
// was getting overwritten by validation pings before we could inspect real
// events. Remove once done.
router.get("/wxrks/debug-last/:accountId", async (req, res) => {
  try {
    const history = await store.getDebugWebhookPayload(req.params.accountId);
    res.json(history.length > 0 ? { history } : { message: "No webhook received yet" });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
