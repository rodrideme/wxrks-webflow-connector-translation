const webflow = require("./webflow");
const wxrks = require("./wxrks");
const store = require("../store");

/**
 * Adds one Webflow item to an *already-created* wxrks project as a single
 * resource (all its translatable fields bundled into one JSON file) + one
 * work unit, and records it in that project's batch mapping. A whole sync
 * run (Full Sync, a multi-item Item Sync selection, or an Auto Sync flush)
 * shares a single wxrks project rather than creating one project per item,
 * and each item gets exactly one work unit rather than one per field.
 */
async function syncItemIntoBatch({ projectUuid, collection, item, targetLocales, namePattern }) {
  const fieldTypeBySlug = webflow.getFieldTypeMap(collection);
  const exclusions = await store.getFieldExclusions(collection.id);
  const translatableFields = webflow.filterTranslatableFields(item.fieldData, fieldTypeBySlug, exclusions);

  if (Object.keys(translatableFields).length === 0) {
    return { skipped: true, reason: "no translatable fields" };
  }

  const filename = webflow.buildResourceFileName(namePattern, { collection, item });
  const resource = await wxrks.createResource(projectUuid, { name: filename });
  const fileContent = Buffer.from(JSON.stringify(translatableFields), "utf-8");
  await wxrks.uploadResourceContent(projectUuid, resource.resourceId, fileContent, filename);

  await wxrks.createWorkUnitsBulk(projectUuid, [{ resourceId: resource.resourceId, targetLocales }]);

  const fieldKeys = Object.keys(translatableFields);
  const wordCount = webflow.countWords(translatableFields);

  await store.addItemToProjectMapping(projectUuid, {
    webflowCollectionId: collection.id,
    webflowItemId: item.id,
    resourceId: resource.resourceId,
    resourceFileName: filename,
    fieldKeys,
    wordCount,
  });

  return { skipped: false, fieldsCount: fieldKeys.length, wordCount };
}

/**
 * Kicks off auto-approval for a whole batch project once, after every item
 * in it has been synced -- not per item. Runs in the background: polling
 * for wxrks's async status propagation can take up to ~45s per phase, far
 * too long to hold a sync request (or a batch loop) open for.
 */
function requestBatchApproval(projectUuid) {
  wxrks
    .approveProject(projectUuid)
    .then((wxrksStatus) => store.updateProjectMapping(projectUuid, { wxrksStatus }))
    .catch((err) => console.error(`Auto-approve failed for wxrks project ${projectUuid}:`, err.message));
}

module.exports = { syncItemIntoBatch, requestBatchApproval };
