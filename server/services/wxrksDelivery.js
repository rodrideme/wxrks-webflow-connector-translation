/**
 * Pushes one delivered wxrks work unit's translation into Webflow and
 * records the result on its project mapping. Extracted so this exact
 * logic (including slug handling) runs identically whether it's triggered
 * by the live wxrks webhook (routes/webhooks.js, event-driven) or by
 * wxrksDeliveryReconciliation.js's periodic poll (the safety net for
 * whenever the webhook itself didn't fire, for any reason -- wxrks has no
 * webhook-management API at all, so unlike the Webflow side, the webhook
 * registration itself can never be auto-repaired, only the missed
 * deliveries it causes). Must be called from within the correct account's
 * accountContext -- both callers already establish this before invoking it.
 */

const webflow = require("./webflow");
const webflowDom = require("./webflowDom");
const store = require("../store");
const autoSyncSelfWrites = require("./autoSyncSelfWrites");
const transliterationLlm = require("./transliterationLlm");

/**
 * Resolves which of the mapping's items a wxrks-reported filename belongs
 * to. An exact match against the resourceFileName we stored at send time
 * is NOT enough: wxrks silently truncates long resource filenames
 * (confirmed live -- a "blog-how-to-translate-a-webflow-...-website.json"
 * upload came back in both the webhook payload and GET /project as
 * "blog-how-to-translate-a-webflow.json", cut ~31 chars into the
 * basename), which used to kill BOTH delivery paths for any item with a
 * long slug: the webhook 404'd and the reconciliation poll skipped it.
 * Fallbacks: case-insensitive, then their-truncated-basename-is-a-prefix
 * of exactly ONE stored name -- ambiguity refuses to match rather than
 * guessing, since a wrong match would deliver a translation into the
 * wrong Webflow item.
 */
function findBatchItemForFileName(mapping, fileName) {
  const items = mapping.items || [];
  const exact = items.find((i) => i.resourceFileName === fileName);
  if (exact) return exact;

  const base = (name) =>
    String(name || "")
      .toLowerCase()
      .replace(/\.json$/, "");
  const target = base(fileName);
  if (!target) return undefined;

  const caseInsensitive = items.filter((i) => base(i.resourceFileName) === target);
  if (caseInsensitive.length === 1) return caseInsensitive[0];

  const prefixMatches = items.filter((i) => base(i.resourceFileName).startsWith(target));
  return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
}

/**
 * `batchItem` is the matching entry from `mapping.items` (see
 * routes/webhooks.js's docstring for its shape); `translation` is the
 * already-downloaded translated-field map for this (work unit, locale).
 */
async function deliverWorkUnitToWebflow({ mapping, batchItem, locale, translation }) {
  const { autoPublish, slugHandling } = await store.getSettings(mapping.accountId);
  const {
    entityType = "cmsItem",
    webflowCollectionId,
    webflowItemId,
    webflowPageId,
    webflowComponentId,
    fieldKeys,
    wordCount,
    sourceName,
    sourceSlug,
  } = batchItem;
  const isPage = entityType === "page";
  const isComponent = entityType === "component";

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

  // Slug handling (settings.slugHandling): the raw slug is never sent to
  // wxrks (see the guard above) -- instead, when enabled, a new slug is
  // derived locally from the item's own TRANSLATED name (both modes --
  // this used to feed "transliterate" mode the source-locale name instead,
  // which is a no-op whenever the source is already Latin script, e.g. an
  // English site: transliterating "Cases" produces "cases" every time,
  // regardless of target locale, since there's nothing non-Latin in it to
  // convert. Confirmed live against a real Arabic target -- the slug came
  // back as the plain English word. Using the translated name instead means
  // "transliterate" romanizes whatever script THAT target locale's
  // translation actually came back in.) and written straight into this
  // same patch. Skipped entirely for pages/components (no slug concept)
  // and whenever the source item had no slug to begin with (nothing to
  // validate a fallback against).
  if (entityType === "cmsItem" && slugHandling.mode !== "source" && sourceSlug) {
    const nameForSlug = translation?.name ?? sourceName;
    let candidateSlug = webflow.sanitizeSlug(nameForSlug, {
      maxLength: slugHandling.maxLength,
      transliterate: slugHandling.mode === "transliterate",
      fallback: sourceSlug,
    });
    // The built-in Cyrillic/Greek map can't handle CJK, Arabic, Hebrew,
    // etc. -- when it fell all the way back to the untouched source slug,
    // try this account's own connected LLM (if any) as a fallback rather
    // than silently giving up. Its output still goes through the exact
    // same sanitizer/fallback afterward -- never trusted directly.
    if (slugHandling.mode === "transliterate" && candidateSlug === sourceSlug) {
      const llmConnection = await store.getLlmConnection(mapping.accountId);
      if (llmConnection) {
        try {
          const llmText = await transliterationLlm.transliterateViaLlm(llmConnection.apiKey, nameForSlug);
          candidateSlug = webflow.sanitizeSlug(llmText, { maxLength: slugHandling.maxLength, fallback: sourceSlug });
        } catch (err) {
          console.error("LLM transliteration fallback failed:", err.response?.data?.error?.message || err.message);
        }
      }
    }
    if (candidateSlug && candidateSlug !== sourceSlug) {
      fieldData.slug = candidateSlug;
    }
  }

  let resultsByLocale;
  if (Object.keys(fieldData).length === 0) {
    resultsByLocale = [{ locale, error: "Downloaded translation had no matching fields" }];
  } else if (isComponent) {
    try {
      // Splits the translated fieldData dict back into a component's own
      // DOM-node writes + placement overrides (one POST .../dom call,
      // same as before) and its definition-level Component Properties (a
      // wholly separate endpoint) -- see webflowDom.js's docstring. Either
      // half can be empty (e.g. a properties-only component now correctly
      // skips the pointless DOM call entirely, where before it silently
      // translated nothing at all).
      const { nodeUpdates, propertyUpdates } = webflowDom.splitTranslatedContent(fieldData);
      if (nodeUpdates.length > 0) {
        await webflow.updateComponentDom(webflowComponentId, locale, nodeUpdates);
      }
      if (propertyUpdates.length > 0) {
        await webflow.updateComponentProperties(webflowComponentId, locale, propertyUpdates);
      }
      resultsByLocale = [{ locale, fieldsUpdated: Object.keys(fieldData).length }];
    } catch (err) {
      resultsByLocale = [{ locale, error: err.response?.data?.message || err.message }];
    }
  } else if (isPage) {
    try {
      // propertyUpdates is always empty for a page (no definition-properties
      // channel there) -- nodeUpdates alone covers plain text nodes and any
      // component-instance overrides placed on this page.
      const { nodeUpdates } = webflowDom.splitTranslatedContent(fieldData);
      await webflow.updatePageDom(webflowPageId, locale, nodeUpdates);
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
  const updatedMapping = await store.addWebflowUpdateToProjectMapping(mapping.wxrksProjectUUID, {
    targetLocales: [locale],
    itemsUpdated: fieldsUpdated > 0 ? 1 : 0,
    wordCount: fieldsUpdated > 0 ? wordCount : 0,
    autoPublish,
    resultsByItem: [resultEntry],
  });

  // wxrks fires delivery per (work unit, locale) rather than once for the
  // whole batch, so there's no single "project done" signal to key off --
  // instead mark the batch completed once every (item, locale) pair has a
  // recorded delivery. Locale keys normalized: old entries recorded
  // wxrks's raw spelling ("de_de") while mapping.targetLocales holds the
  // site tag ("de-DE") -- unnormalized, those pairs never counted and the
  // run never flipped to completed.
  const expectedPairs = mapping.items.length * mapping.targetLocales.length;
  const deliveredPairs = new Set(
    updatedMapping.updates.flatMap((u) =>
      (u.resultsByItem || []).flatMap((r) =>
        u.targetLocales.map((l) => `${r.webflowComponentId || r.webflowPageId || r.webflowItemId}:${webflow.normalizeLocaleTag(l)}`)
      )
    )
  ).size;
  if (deliveredPairs >= expectedPairs) {
    await store.updateProjectMapping(mapping.wxrksProjectUUID, { status: "completed" });
  }

  return updatedMapping;
}

/**
 * Same dedup check the wxrks webhook handler applies before doing any work
 * -- true when this (item, locale) already has a successful push recorded,
 * so both the live webhook and the reconciliation safety net skip anything
 * already delivered instead of double-processing it. Locale comparison is
 * NORMALIZED (webflow.normalizeLocaleTag): wxrks spells locales its own
 * way ("de_de") and older update entries recorded that raw form, while
 * callers may pass the site's real tag ("de-DE") -- strict equality here
 * would re-deliver (or fail to dedup) across the two spellings.
 *
 * `withinMs` (optional) bounds the lookback to only that recent a window,
 * instead of the item/locale's entire history -- the live webhook handler
 * passes this to dedup the near-simultaneous WORK_UNIT_TRANSLATION_FILE_READY
 * / WORK_UNIT_STATUS_CHANGE pair for ONE delivery without also permanently
 * blocking a genuine re-delivery (the Task going back to an earlier status,
 * getting re-translated, and reaching DELIVERED again). The reconciliation
 * safety net omits it, since "ever delivered" is exactly what it wants.
 */
function alreadyDelivered(mapping, batchItem, locale, withinMs) {
  const { entityType = "cmsItem", webflowItemId, webflowPageId, webflowComponentId } = batchItem;
  const isPage = entityType === "page";
  const isComponent = entityType === "component";
  const wanted = webflow.normalizeLocaleTag(locale);
  const cutoff = withinMs ? Date.now() - withinMs : 0;
  return mapping.updates.some(
    (u) =>
      new Date(u.updatedAt).getTime() >= cutoff &&
      (u.targetLocales || []).some((l) => webflow.normalizeLocaleTag(l) === wanted) &&
      (u.resultsByItem || []).some(
        (r) =>
          (isComponent ? r.webflowComponentId === webflowComponentId : isPage ? r.webflowPageId === webflowPageId : r.webflowItemId === webflowItemId) &&
          (r.resultsByLocale || []).some((rl) => webflow.normalizeLocaleTag(rl.locale) === wanted && rl.fieldsUpdated > 0)
      )
  );
}

/**
 * Persists a delivery attempt that failed BEFORE any Webflow write could
 * record its own result (e.g. downloading the translated file from wxrks
 * failed) -- without this the only trace was a server log line, and the
 * run showed the work unit "Pending" forever with no visible reason. Same
 * updates[] entry shape as a normal delivery, so the Runs/History UI
 * renders it as a failed attempt with no special handling.
 */
async function recordDeliveryFailure({ mapping, batchItem, locale, error }) {
  const { entityType = "cmsItem", webflowCollectionId, webflowItemId, webflowPageId, webflowComponentId } = batchItem;
  const resultsByLocale = [{ locale, error }];
  const resultEntry =
    entityType === "component"
      ? { webflowComponentId, resultsByLocale }
      : entityType === "page"
      ? { webflowPageId, resultsByLocale }
      : { webflowCollectionId, webflowItemId, resultsByLocale };
  return store.addWebflowUpdateToProjectMapping(mapping.wxrksProjectUUID, {
    targetLocales: [locale],
    itemsUpdated: 0,
    wordCount: 0,
    autoPublish: false,
    resultsByItem: [resultEntry],
  });
}

module.exports = { deliverWorkUnitToWebflow, alreadyDelivered, recordDeliveryFailure, findBatchItemForFileName };
