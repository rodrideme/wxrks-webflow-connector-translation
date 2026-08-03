/**
 * wxrks delivery safety net. wxrks exposes no webhook-management API at all
 * (confirmed against their real Postman collection -- the "Webhooks" folder
 * has zero request definitions, only a description saying subscriptions are
 * configured through wxrks's own dashboard), so unlike the Webflow side,
 * there is no way to auto-repair the webhook registration itself if it ever
 * points at a stale URL (e.g. after a domain change -- see the "Vamos"
 * incident this was built for). What's achievable instead: periodically
 * poll wxrks directly for any work unit that's actually finished translating
 * but never got pushed to Webflow, and push it -- catching a missed
 * delivery regardless of *why* the webhook didn't fire.
 *
 * Invoked from autoSyncReconciliation.js's existing hourly loop (no new
 * timer) -- one extra `GET /project/:uuid` call per in-progress project per
 * pass is cheap next to that job's own per-collection Webflow re-scans.
 */

const wxrks = require("./wxrks");
const store = require("../store");
const webflow = require("./webflow");
const wxrksDelivery = require("./wxrksDelivery");

function workUnitUuidOf(workUnit) {
  return workUnit.uuid || workUnit.id;
}

function isDeliveredWorkUnit(workUnit) {
  return ["DELIVERED"].includes(workUnit.workStatus || workUnit.status || workUnit.taskStatus || workUnit.workUnitStatus);
}

async function reconcileWxrksDeliveriesForAccount(accountId) {
  const activeProjects = await store.listActiveProjects(accountId);
  for (const mapping of activeProjects) {
    let project;
    try {
      project = await wxrks.getProject(mapping.wxrksProjectUUID);
    } catch (err) {
      console.error(`wxrks delivery reconciliation: couldn't fetch project ${mapping.wxrksProjectUUID}:`, err.message);
      continue;
    }

    for (const workUnit of project.workUnits || []) {
      // Matches the same way routes/webhooks.js's live handler does --
      // wxrks's own filename is the only stable link back to which of our
      // batch items (and which entity) this work unit is for, since we
      // never captured wxrks's work-unit uuid at send time.
      const batchItem = wxrksDelivery.findBatchItemForFileName(mapping, workUnit.filename);
      const locale = workUnit.targetLanguage;
      const workUnitUuid = workUnitUuidOf(workUnit);
      if (!batchItem || !locale || !workUnitUuid) continue;
      if (wxrksDelivery.alreadyDelivered(mapping, batchItem, locale)) continue;

      try {
        const info = await wxrks.getWorkUnitTranslation(mapping.wxrksProjectUUID, workUnitUuid);
        if (info.translationStatus === "TRANSLATED" && info.translatedFileUrl) {
          const translation = await wxrks.fetchTranslatedFile(info.translatedFileUrl);
          // Record under the site's real tag, same as the live webhook path
          // (wxrks reports "de_de"; the Runs page matches on "de-DE").
          const canonicalLocale = await webflow.resolveSiteLocaleTag(locale);
          await wxrksDelivery.deliverWorkUnitToWebflow({ mapping, batchItem, locale: canonicalLocale, translation });
          continue;
        }

        if (isDeliveredWorkUnit(workUnit) && info.translationStatus !== "PREPARING") {
          await wxrks.requestWorkUnitTranslation(mapping.wxrksProjectUUID, workUnitUuid);
        }
      } catch (err) {
        // Not ready yet, or a real error either way -- try again next pass.
        // If the WU is delivered, make one best-effort request so a missed
        // WORK_UNIT_STATUS_CHANGE webhook does not leave the file unbuilt.
        if (isDeliveredWorkUnit(workUnit)) {
          await wxrks.requestWorkUnitTranslation(mapping.wxrksProjectUUID, workUnitUuid).catch(() => {});
        }
      }
    }
  }
}

module.exports = { reconcileWxrksDeliveriesForAccount };
