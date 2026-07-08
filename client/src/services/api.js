// Render's free tier spins the app down when idle -- the first request after
// a spin-down can take 10-15s to wake it back up, and requests made while
// it's still coming up can fail with a transient 5xx or a network-level
// error before it's actually ready. Retried only for idempotent GETs (with a
// growing backoff, capped at a few attempts) so a page's initial data load
// recovers on its own instead of surfacing a scary error for something that
// resolves itself in a few seconds. Never retried for a mutating call
// (POST/PUT/DELETE) -- if that request actually succeeded server-side and
// only the response got lost to the same hiccup, blindly retrying could
// double-create a real wxrks project or automation.
const RETRY_DELAYS_MS = [1000, 2000, 3000, 4000];

async function request(path, options = {}) {
  const isIdempotent = !options.method || options.method.toUpperCase() === "GET";
  const maxAttempts = isIdempotent ? RETRY_DELAYS_MS.length + 1 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(`/api${path}`, {
        headers: { "Content-Type": "application/json" },
        ...options,
      });
    } catch (err) {
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
        continue;
      }
      throw err;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (isIdempotent && res.status >= 500 && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
        continue;
      }
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    return data;
  }
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
