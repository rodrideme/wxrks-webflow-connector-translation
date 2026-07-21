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
async function syncTranslatableContentIntoBatch({ projectUuid, translatableContent, filename, targetLocales, mappingFields, workflows, previewUrl }) {
  if (Object.keys(translatableContent).length === 0) {
    return { skipped: true, reason: "no translatable content" };
  }

  const resource = await wxrks.createResource(projectUuid, { name: filename, previewUrl });
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
    previewUrl,
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
async function syncItemIntoBatch({ accountId, projectUuid, collection, item, targetLocales, namePattern, workflows, site, templatePage }) {
  const fieldTypeBySlug = webflow.getFieldTypeMap(collection);
  const exclusions = await store.getFieldExclusions(accountId, collection.id);
  const translatableFields = webflow.filterTranslatableFields(item.fieldData, fieldTypeBySlug, exclusions);
  const filename = webflow.buildResourceFileName(namePattern, { collection, item });
  // templatePage is the collection's real Collection Page (see
  // webflow.findCollectionTemplatePage) -- its own slug is the real URL
  // segment, which commonly differs from the collection's own slug.
  // A draft source item has no real "live" URL -- buildCmsItemPreviewUrl
  // only checks that site/template/slug exist, not publish status, so it
  // would otherwise construct one anyway and point wxrks reviewers at
  // content that isn't actually online yet.
  const previewUrl = item.isDraft ? undefined : webflow.buildCmsItemPreviewUrl({ site, templatePage, item });

  return syncTranslatableContentIntoBatch({
    projectUuid,
    translatableContent: translatableFields,
    filename,
    targetLocales,
    workflows,
    previewUrl,
    mappingFields: {
      entityType: "cmsItem",
      webflowCollectionId: collection.id,
      webflowItemId: item.id,
      // Carried through to write-back time (webhooks.js) so slugHandling
      // can derive/validate a new slug without a second live Webflow fetch.
      sourceName: item.fieldData?.name,
      sourceSlug: item.fieldData?.slug,
    },
  });
}

/**
 * Adds one Webflow static page to an already-created wxrks project.
 * `nodes` is the page's full primary-locale DOM node list (pre-fetched by
 * the caller via webflow.getPageDom(page.id, {locale: sourceLocale}), same
 * pattern as syncItemIntoBatch receiving a pre-fetched `item`). v1 scope:
 * only `type: "text"` nodes are extracted (see webflowDom.js). Also passes
 * the account's whole componentPropertyExclusions/autoExcludeKeywords
 * through to extractTextNodes, so a component-instance placed on this page
 * has its excluded/auto-excluded properties' overrides skipped too --
 * exactly like syncComponentIntoBatch does for that component's own
 * definition-level properties.
 */
async function syncPageIntoBatch({ accountId, projectUuid, page, nodes, targetLocales, namePattern, workflows, site, folder }) {
  const { componentPropertyExclusions, componentPropertyAutoExcludeKeywords } = await store.getSettings(accountId);
  const translatableNodes = webflowDom.extractTextNodes(nodes, componentPropertyExclusions, componentPropertyAutoExcludeKeywords);
  const filename = webflow.buildPageResourceFileName(namePattern, { page });
  const previewUrl = webflow.buildPagePreviewUrl({ site, page, folder });

  return syncTranslatableContentIntoBatch({
    projectUuid,
    translatableContent: translatableNodes,
    filename,
    targetLocales,
    workflows,
    previewUrl,
    mappingFields: { entityType: "page", webflowPageId: page.id },
  });
}

/**
 * Adds one Webflow Component *definition* to an already-created wxrks
 * project -- translating it once so the translation propagates everywhere
 * that component is used across the site (except wherever a specific
 * placement overrides a property -- those overrides travel with whatever
 * page/component contains that placement instead, via syncPageIntoBatch's
 * extractTextNodes call). `nodes` is the component's full primary-locale
 * DOM node list (pre-fetched via webflow.getComponentDom(component.id,
 * {locale: sourceLocale})); `properties` is its definition-level Component
 * Properties (pre-fetched via webflow.getComponentProperties(component.id,
 * {locale: sourceLocale})) -- a channel entirely separate from the DOM
 * nodes (confirmed live: zero overlap), merged into the same translatable
 * dict so a properties-only component (previously zero translatable
 * content) is no longer silently skipped.
 */
async function syncComponentIntoBatch({ accountId, projectUuid, component, nodes, properties, targetLocales, namePattern, workflows }) {
  const { componentPropertyExclusions, componentPropertyAutoExcludeKeywords } = await store.getSettings(accountId);
  const exclusions = componentPropertyExclusions[component.id] || [];
  const translatableContent = {
    ...webflowDom.extractTextNodes(nodes, componentPropertyExclusions, componentPropertyAutoExcludeKeywords),
    ...webflowDom.extractComponentProperties(properties, exclusions, componentPropertyAutoExcludeKeywords),
  };
  const filename = webflow.buildComponentResourceFileName(namePattern, { component });

  return syncTranslatableContentIntoBatch({
    projectUuid,
    translatableContent,
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
