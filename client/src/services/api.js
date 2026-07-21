import dataCache from "./dataCache.js";

// Structural Webflow content (which collections/pages/components/org units
// exist) only changes when someone edits it in Webflow's/wxrks's own UI,
// not through this app -- safe to serve stale for a while (persisted via
// dataCache's sessionStorage layer, so this survives a hard refresh too,
// not just in-app navigation). `settings` has real in-app mutators (see
// below) that already invalidate it explicitly on save -- this TTL is only
// a safety net for staleness from another tab/session, not the primary
// freshness mechanism, so it's fine at the same duration.
const STRUCTURAL_TTL_MS = 30 * 60 * 1000;
const SETTINGS_TTL_MS = 30 * 60 * 1000;

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
      // A session that expired or got revoked mid-use (not just a fresh
      // page load without one) -- AuthContext registers this hook so the
      // app drops back to the login screen instead of every subsequent
      // call just silently erroring. Not fired for /auth/me itself, which
      // reports "logged out" via a 200 with null fields, never a 401.
      if (res.status === 401) api.onUnauthorized?.();
      const err = new Error(data.error || `Request failed: ${res.status}`);
      if (data.code) err.code = data.code;
      throw err;
    }
    return data;
  }
}

const api = {
  // Set by AuthContext on mount; called whenever any request comes back 401.
  onUnauthorized: null,
  getMe: () => request("/auth/me"),
  logout: () => request("/auth/logout", { method: "POST" }),
  getCollections: () => dataCache.getOrFetch("collections", STRUCTURAL_TTL_MS, () => request("/collections")),
  getCollectionItems: (collectionId) => request(`/collections/${collectionId}/items`),
  getCollectionItemsSummary: (collectionId, offset = 0) => request(`/collections/${collectionId}/items-summary?offset=${offset}`),
  getBacklog: () => request("/backlog"),
  getSyncStatus: () => request("/sync/status"),
  syncItem: (collectionId, itemIds, options = {}) =>
    request("/sync/item", { method: "POST", body: JSON.stringify({ collectionId, itemIds, ...options }) }),
  syncCombined: (groups, options = {}) =>
    request("/sync/combined", { method: "POST", body: JSON.stringify({ groups, ...options }) }),
  getSyncJob: (jobId) => request(`/sync/jobs/${jobId}`),
  cancelSyncJob: (jobId) => request(`/sync/jobs/${jobId}/cancel`, { method: "POST" }),
  getSettings: () => dataCache.getOrFetch("settings", SETTINGS_TTL_MS, () => request("/settings")),
  updateSettings: (settings) =>
    request("/settings", { method: "PUT", body: JSON.stringify(settings) }).then((updated) => {
      dataCache.invalidate("settings");
      return updated;
    }),
  getOrgUnits: () => dataCache.getOrFetch("orgUnits", STRUCTURAL_TTL_MS, () => request("/config/org-units")),
  getOrgUnitResources: (orgUnitUUID) => request(`/config/org-units/${orgUnitUUID}/resources`),
  getWebflowLocales: () => dataCache.getOrFetch("webflowLocales", STRUCTURAL_TTL_MS, () => request("/config/webflow-locales")),
  getSyncHistory: () => request("/sync/history"),
  getRunWorkUnits: (wxrksProjectUUID) => request(`/sync/history/${wxrksProjectUUID}/work-units`),
  getCollectionFields: (collectionId) => request(`/collections/${collectionId}/fields`),
  getFieldsSummary: () => request("/collections/fields-summary"),
  updateFieldExclusions: (collectionId, excludedFields) =>
    request(`/collections/${collectionId}/field-exclusions`, {
      method: "PUT",
      body: JSON.stringify({ excludedFields }),
    }),
  reregisterAutoSyncWebhook: () => request("/settings/autosync/reregister-webhook", { method: "POST" }),
  reregisterPagesWebhook: () => request("/settings/autosync/reregister-pages-webhook", { method: "POST" }),
  saveWxrksConnection: (accessKey, secret) =>
    request("/settings/wxrks-connection", { method: "PUT", body: JSON.stringify({ accessKey, secret }) }).then((res) => {
      dataCache.invalidate("settings"); // response embeds wxrksConnected/wxrksAccessKeyMasked
      return res;
    }),
  deleteWxrksConnection: () =>
    request("/settings/wxrks-connection", { method: "DELETE" }).then((res) => {
      dataCache.invalidate("settings");
      return res;
    }),
  testWxrksConnection: () => request("/settings/wxrks-connection/test", { method: "POST" }),
  saveLlmConnection: (apiKey) =>
    request("/settings/llm-connection", { method: "PUT", body: JSON.stringify({ apiKey }) }).then((res) => {
      dataCache.invalidate("settings"); // response embeds llmConnected/llmApiKeyMasked
      return res;
    }),
  deleteLlmConnection: () =>
    request("/settings/llm-connection", { method: "DELETE" }).then((res) => {
      dataCache.invalidate("settings");
      return res;
    }),
  getPages: () => dataCache.getOrFetch("pages", STRUCTURAL_TTL_MS, () => request("/sync/pages/list")),
  getPageFolders: () => dataCache.getOrFetch("pageFolders", STRUCTURAL_TTL_MS, () => request("/sync/pages/folders")),
  syncPagesItem: (pageIds, options = {}) =>
    request("/sync/pages/item", { method: "POST", body: JSON.stringify({ pageIds, ...options }) }),
  getComponents: () => dataCache.getOrFetch("components", STRUCTURAL_TTL_MS, () => request("/sync/components/list")),
  syncComponentsItem: (componentIds, options = {}) =>
    request("/sync/components/item", { method: "POST", body: JSON.stringify({ componentIds, ...options }) }),
  getComponentProperties: (componentId) => request(`/sync/components/${componentId}/properties`),
  updateComponentPropertyExclusions: (componentId, excludedPropertyIds) =>
    request(`/sync/components/${componentId}/property-exclusions`, {
      method: "PUT",
      body: JSON.stringify({ excludedPropertyIds }),
    }),
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
  getTeam: () => request("/team"),
  setTeamMemberAccessLevel: (userId, accessLevel) =>
    request(`/team/${userId}/access-level`, { method: "PUT", body: JSON.stringify({ accessLevel }) }),
  getActivity: (offset = 0, limit = 50) => request(`/team/activity?offset=${offset}&limit=${limit}`),
  listTeamInvites: () => request("/team/invites"),
  createTeamInvite: (payload = {}) => request("/team/invites", { method: "POST", body: JSON.stringify(payload) }),
  revokeTeamInvite: (id) => request(`/team/invites/${id}/revoke`, { method: "POST" }),
  listEnvironments: () => request("/environments"),
  createEnvironment: (payload = {}) => request("/environments", { method: "POST", body: JSON.stringify(payload) }),
  revokeEnvironment: (id) => request(`/environments/${id}/revoke`, { method: "POST" }),
  checkInvite: (token) => request(`/connect/invite/${encodeURIComponent(token)}`),
  redeemInvite: (payload) => request("/connect/redeem", { method: "POST", body: JSON.stringify(payload) }),
  loginWithPassword: (email, password) => request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  forgotPassword: (email) => request("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) }),
  resetPassword: (token, newPassword) => request("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, newPassword }) }),
  setPassword: (newPassword) => request("/auth/set-password", { method: "POST", body: JSON.stringify({ newPassword }) }),
};

export default api;
