const webflow = require("./webflow");
const webflowDom = require("./webflowDom");
const wxrks = require("./wxrks");
const store = require("../store");

/**
 * Content-agnostic core shared by every entity kind (CMS item, page,
 * component): uploads a flat { key: translatableText } dict as one
 * wxrks resource + work unit, and records it in the batch's project
 * mapping. Callers do the entity-specific work of extracting that flat
 * dict and building the mapping fields (entityType + whichever id(s)
 * apply) before calling this.
 */
async function syncTranslatableContentIntoBatch({ projectUuid, translatableContent, filename, targetLocales, mappingFields, workflows }) {
  if (Object.keys(translatableContent).length === 0) {
    return { skipped: true, reason: "no translatable content" };
  }

  const resource = await wxrks.createResource(projectUuid, { name: filename });
  const fileContent = Buffer.from(JSON.stringify(translatableContent), "utf-8");
  await wxrks.uploadResourceContent(projectUuid, resource.resourceId, fileContent, filename);

  await wxrks.createWorkUnitsBulk(projectUuid, [{ resourceId: resource.resourceId, targetLocales, workflows }]);

  const fieldKeys = Object.keys(translatableContent);
  const wordCount = webflow.countWords(translatableContent);

  await store.addItemToProjectMapping(projectUuid, {
    ...mappingFields,
    resourceId: resource.resourceId,
    resourceFileName: filename,
    fieldKeys,
    wordCount,
  });

  return { skipped: false, fieldsCount: fieldKeys.length, wordCount };
}

/**
 * Adds one Webflow CMS item to an *already-created* wxrks project as a
 * single resource (all its translatable fields bundled into one JSON
 * file) + one work unit. A whole sync run (Bulk Sync, a multi-item Item
 * Sync selection, or an Auto Sync flush) shares a single wxrks project
 * rather than creating one project per item, and each item gets exactly
 * one work unit rather than one per field.
 */
async function syncItemIntoBatch({ projectUuid, collection, item, targetLocales, namePattern, workflows }) {
  const fieldTypeBySlug = webflow.getFieldTypeMap(collection);
  const exclusions = await store.getFieldExclusions(collection.id);
  const translatableFields = webflow.filterTranslatableFields(item.fieldData, fieldTypeBySlug, exclusions);
  const filename = webflow.buildResourceFileName(namePattern, { collection, item });

  return syncTranslatableContentIntoBatch({
    projectUuid,
    translatableContent: translatableFields,
    filename,
    targetLocales,
    workflows,
    mappingFields: { entityType: "cmsItem", webflowCollectionId: collection.id, webflowItemId: item.id },
  });
}

/**
 * Adds one Webflow static page to an already-created wxrks project.
 * `nodes` is the page's full primary-locale DOM node list (pre-fetched by
 * the caller via webflow.getPageDom(page.id, {locale: sourceLocale}), same
 * pattern as syncItemIntoBatch receiving a pre-fetched `item`). v1 scope:
 * only `type: "text"` nodes are extracted (see webflowDom.js).
 */
async function syncPageIntoBatch({ projectUuid, page, nodes, targetLocales, namePattern, workflows }) {
  const translatableNodes = webflowDom.extractTextNodes(nodes);
  const filename = webflow.buildPageResourceFileName(namePattern, { page });

  return syncTranslatableContentIntoBatch({
    projectUuid,
    translatableContent: translatableNodes,
    filename,
    targetLocales,
    workflows,
    mappingFields: { entityType: "page", webflowPageId: page.id },
  });
}

/**
 * Adds one Webflow Component *definition* to an already-created wxrks
 * project -- translating it once so the translation propagates everywhere
 * that component is used across the site. Same shape as syncPageIntoBatch;
 * `nodes` is the component's full primary-locale DOM node list (pre-fetched
 * via webflow.getComponentDom(component.id, {locale: sourceLocale})).
 */
async function syncComponentIntoBatch({ projectUuid, component, nodes, targetLocales, namePattern, workflows }) {
  const translatableNodes = webflowDom.extractTextNodes(nodes);
  const filename = webflow.buildComponentResourceFileName(namePattern, { component });

  return syncTranslatableContentIntoBatch({
    projectUuid,
    translatableContent: translatableNodes,
    filename,
    targetLocales,
    workflows,
    mappingFields: { entityType: "component", webflowComponentId: component.id },
  });
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

module.exports = { syncItemIntoBatch, syncPageIntoBatch, syncComponentIntoBatch, requestBatchApproval };
