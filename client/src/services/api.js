async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }

  return data;
}

const api = {
  getCollections: () => request("/collections"),
  getCollectionItems: (collectionId) => request(`/collections/${collectionId}/items`),
  getBacklog: () => request("/backlog"),
  getSyncStatus: () => request("/sync/status"),
  previewBulkSync: (translateFromDate) =>
    request("/sync/bulk", { method: "POST", body: JSON.stringify({ translateFromDate, dryRun: true }) }),
  syncBulk: (translateFromDate) =>
    request("/sync/bulk", { method: "POST", body: JSON.stringify({ translateFromDate }) }),
  getBulkSyncJob: (jobId) => request(`/sync/bulk/${jobId}`),
  cancelBulkSyncJob: (jobId) => request(`/sync/bulk/${jobId}/cancel`, { method: "POST" }),
  syncItem: (collectionId, itemIds) =>
    request("/sync/item", { method: "POST", body: JSON.stringify({ collectionId, itemIds }) }),
  getSettings: () => request("/settings"),
  updateSettings: (settings) =>
    request("/settings", { method: "PUT", body: JSON.stringify(settings) }),
  getOrgUnits: () => request("/config/org-units"),
  getOrgUnitResources: (orgUnitUUID) => request(`/config/org-units/${orgUnitUUID}/resources`),
  getWebflowLocales: () => request("/config/webflow-locales"),
  getSyncHistory: () => request("/sync/history"),
  getCollectionFields: (collectionId) => request(`/collections/${collectionId}/fields`),
  updateFieldExclusions: (collectionId, excludedFields) =>
    request(`/collections/${collectionId}/field-exclusions`, {
      method: "PUT",
      body: JSON.stringify({ excludedFields }),
    }),
  updateAutoSyncFieldConditions: (collectionId, conditions) =>
    request(`/collections/${collectionId}/auto-sync-conditions`, {
      method: "PUT",
      body: JSON.stringify({ conditions }),
    }),
  getAutoSyncStatus: () => request("/sync/auto/status"),
  flushAutoSyncNow: () => request("/sync/auto/flush", { method: "POST" }),
  reregisterAutoSyncWebhook: () => request("/settings/autosync/reregister-webhook", { method: "POST" }),
  getPages: () => request("/sync/pages/list"),
  previewPagesBulkSync: () => request("/sync/pages/bulk", { method: "POST", body: JSON.stringify({ dryRun: true }) }),
  syncPagesBulk: () => request("/sync/pages/bulk", { method: "POST", body: JSON.stringify({}) }),
  getPagesBulkSyncJob: (jobId) => request(`/sync/pages/bulk/${jobId}`),
  cancelPagesBulkSyncJob: (jobId) => request(`/sync/pages/bulk/${jobId}/cancel`, { method: "POST" }),
  syncPagesItem: (pageIds) => request("/sync/pages/item", { method: "POST", body: JSON.stringify({ pageIds }) }),
  getComponents: () => request("/sync/components/list"),
  previewComponentsBulkSync: () =>
    request("/sync/components/bulk", { method: "POST", body: JSON.stringify({ dryRun: true }) }),
  syncComponentsBulk: () => request("/sync/components/bulk", { method: "POST", body: JSON.stringify({}) }),
  getComponentsBulkSyncJob: (jobId) => request(`/sync/components/bulk/${jobId}`),
  cancelComponentsBulkSyncJob: (jobId) => request(`/sync/components/bulk/${jobId}/cancel`, { method: "POST" }),
  syncComponentsItem: (componentIds) =>
    request("/sync/components/item", { method: "POST", body: JSON.stringify({ componentIds }) }),
};

export default api;
