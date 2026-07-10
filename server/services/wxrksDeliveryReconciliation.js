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
const wxrksDelivery = require("./wxrksDelivery");

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
      const batchItem = mapping.items.find((i) => i.resourceFileName === workUnit.filename);
      const locale = workUnit.targetLanguage;
      if (!batchItem || !locale) continue;
      if (wxrksDelivery.alreadyDelivered(mapping, batchItem, locale)) continue;

      try {
        // A single attempt (no retry wait) -- if it's not ready yet, the
        // next hourly pass checks again. This is a periodic safety net, not
        // a live wait, so there's no reason to block this pass on it.
        const translation = await wxrks.waitForWorkUnitTranslation(
          mapping.wxrksProjectUUID,
          workUnit.uuid,
          batchItem.resourceId,
          locale,
          { retries: 0, retryDelayMs: 0 }
        );
        await wxrksDelivery.deliverWorkUnitToWebflow({ mapping, batchItem, locale, translation });
      } catch (err) {
        // Not ready yet, or a real error either way -- try again next pass
        // rather than letting one stuck work unit block the rest of this
        // project's/account's reconciliation.
      }
    }
  }
}

module.exports = { reconcileWxrksDeliveriesForAccount };
