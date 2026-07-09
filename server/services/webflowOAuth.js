/**
 * "Sign in with Webflow" -- the standard OAuth 2.0 Authorization Code Grant
 * (confirmed live against developers.webflow.com/data/reference/oauth-app),
 * used purely to identify who's logging in and which Webflow site(s) they
 * have access to (see routes/auth.js). Not the same axios client as
 * webflow.js -- that one carries this app's single static env-configured
 * WEBFLOW_API_TOKEN; this one exchanges a fresh, per-login authorization
 * code for a token belonging to whichever user just authorized.
 */

const axios = require("axios");

const AUTHORIZE_URL = "https://webflow.com/oauth/authorize";
const TOKEN_URL = "https://api.webflow.com/oauth/access_token";
const API_BASE = "https://api.webflow.com/v2";

// Phase 2: this token is now actually used for real Webflow API calls (see
// services/webflow.js's resolveConnection()), so the grant needs to cover
// everything this app's existing static WEBFLOW_API_TOKEN could already do
// -- CMS items, Pages, and Components. `components:read`/`components:write`
// ARE real, separate scopes (confirmed live via a real 403: "OAuthForbidden:
// You are missing the following scopes - 'components:read'") -- an earlier
// assumption that Components used the Pages scopes was wrong. Every
// existing connected account's token predates this and only has whatever
// scopes were requested before -- those users must log out/in once to pick
// up a token with the broader grant before their account's Webflow calls
// will work.
const SCOPES = "authorized_user:read sites:read cms:read cms:write pages:read pages:write components:read components:write";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function buildAuthorizeUrl(state) {
  const clientId = requireEnv("WEBFLOW_CLIENT_ID");
  const redirectUri = requireEnv("WEBFLOW_OAUTH_REDIRECT_URI");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const { data } = await axios.post(TOKEN_URL, {
    client_id: requireEnv("WEBFLOW_CLIENT_ID"),
    client_secret: requireEnv("WEBFLOW_CLIENT_SECRET"),
    code,
    grant_type: "authorization_code",
    redirect_uri: requireEnv("WEBFLOW_OAUTH_REDIRECT_URI"),
  });
  // NEEDS LIVE VERIFICATION (see plan file): does this response actually
  // include expires_in/refresh_token? Not documented on the OAuth reference
  // page as of this writing. Returned as-is so the caller can inspect the
  // real shape once a live grant exists.
  return data; // { access_token, token_type, ... }
}

/**
 * Which Webflow site(s)/workspace(s) this specific token's grant covers --
 * this is the dedup key that resolves a login to an existing account (or
 * creates a new one). Confirmed live shape:
 *   { authorization: { id, createdOn, lastUsed, grantType, rateLimit,
 *     scope, authorizedTo: { siteIds, workspaceIds, userIds } },
 *     application: {...} }
 */
async function introspectToken(accessToken) {
  const { data } = await axios.get(`${API_BASE}/token/introspect`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data;
}

/**
 * Who is logging in. Confirmed live shape: { id, email, firstName,
 * lastName }. Requires the authorized_user:read scope.
 */
async function getAuthorizedUser(accessToken) {
  const { data } = await axios.get(`${API_BASE}/token/authorized_by`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data;
}

module.exports = { buildAuthorizeUrl, exchangeCodeForToken, introspectToken, getAuthorizedUser };
