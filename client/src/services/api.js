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
  syncItem: (collectionId, itemIds, options = {}) =>
    request("/sync/item", { method: "POST", body: JSON.stringify({ collectionId, itemIds, ...options }) }),
  getSyncJob: (jobId) => request(`/sync/jobs/${jobId}`),
  cancelSyncJob: (jobId) => request(`/sync/jobs/${jobId}/cancel`, { method: "POST" }),
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
  reregisterAutoSyncWebhook: () => request("/settings/autosync/reregister-webhook", { method: "POST" }),
  getPages: () => request("/sync/pages/list"),
  getPageFolders: () => request("/sync/pages/folders"),
  syncPagesItem: (pageIds, options = {}) =>
    request("/sync/pages/item", { method: "POST", body: JSON.stringify({ pageIds, ...options }) }),
  getComponents: () => request("/sync/components/list"),
  syncComponentsItem: (componentIds, options = {}) =>
    request("/sync/components/item", { method: "POST", body: JSON.stringify({ componentIds, ...options }) }),
  listAutomations: () => request("/automations"),
  createAutomation: (automation) => request("/automations", { method: "POST", body: JSON.stringify(automation) }),
  updateAutomation: (id, automation) =>
    request(`/automations/${id}`, { method: "PUT", body: JSON.stringify(automation) }),
  deleteAutomation: (id) => request(`/automations/${id}`, { method: "DELETE" }),
  pauseAutomation: (id) => request(`/automations/${id}/pause`, { method: "POST" }),
  resumeAutomation: (id) => request(`/automations/${id}/resume`, { method: "POST" }),
  archiveAutomation: (id) => request(`/automations/${id}/archive`, { method: "POST" }),
  unarchiveAutomation: (id) => request(`/automations/${id}/unarchive`, { method: "POST" }),
  flushAutomationNow: (id) => request(`/automations/${id}/flush`, { method: "POST" }),
  flushAllAutomations: () => request("/automations/flush-all", { method: "POST" }),
  getAutomationStatus: (id) => request(`/automations/${id}/status`),
};

export default api;
