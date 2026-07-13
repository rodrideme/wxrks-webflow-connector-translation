/**
 * Validates a manually-pasted Webflow Site API token for routes/connect.js
 * (invite-gated sign-up for a workspace "Sign in with Webflow" OAuth can
 * never reach -- see that file). Deliberately separate from webflowOAuth.js,
 * whose docblock frames it specifically around the OAuth flow, and whose
 * token/introspect + token/authorized_by calls are Data-Client (OAuth)-only
 * per Webflow's own docs -- confirmed NOT usable here, see below.
 */

const axios = require("axios");

const API_BASE = "https://api.webflow.com/v2";

/**
 * Which site(s) this exact token can reach -- the ONLY trustworthy source
 * for a site id in the connect flow. Never accept a site id from client
 * input anywhere: that would let a redeemer claim an arbitrary existing
 * account's site and potentially hijack it. `GET /sites` needs only
 * `sites:read` and, unlike token/introspect, is not restricted to OAuth
 * Data Client tokens (confirmed against Webflow's public API docs -- not
 * yet live-tested against a real Site API token, see the plan's spike).
 */
async function listSitesForToken(accessToken) {
  const { data } = await axios.get(`${API_BASE}/sites`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data?.sites || []; // [{ id, displayName, shortName, ... }]
}

/**
 * Best-effort only -- never throws. Per Webflow's docs, token/authorized_by
 * requires a Data Client (OAuth) bearer token, so this is expected to fail
 * for a genuine, manually-generated Site API token; callers must treat
 * `null` as "no live identity available" and fall back to a form-provided
 * name/email instead, never block on this.
 */
async function tryResolveAuthorizedUser(accessToken) {
  try {
    const { data } = await axios.get(`${API_BASE}/token/authorized_by`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return data; // { id, email, firstName, lastName }
  } catch {
    return null;
  }
}

module.exports = { listSitesForToken, tryResolveAuthorizedUser };
