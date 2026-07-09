const crypto = require("crypto");
const express = require("express");
const store = require("../store");
const webflowOAuth = require("../services/webflowOAuth");
const tokenCrypto = require("../services/tokenCrypto");
const { SESSION_COOKIE_NAME, parseCookies } = require("../middleware/auth");

const router = express.Router();

const OAUTH_STATE_COOKIE = "oauth_state";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding (see middleware/auth.js's touchSession)
const OAUTH_STATE_MAX_AGE_MS = 5 * 60 * 1000;

function isProd() {
  return process.env.NODE_ENV === "production" || Boolean(process.env.RENDER_GIT_COMMIT);
}

function setCookie(res, name, value, { maxAgeMs, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (httpOnly) parts.push("HttpOnly");
  if (isProd()) parts.push("Secure");
  if (maxAgeMs !== undefined) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  res.append("Set-Cookie", parts.join("; "));
}

function clearCookie(res, name) {
  res.append("Set-Cookie", `${name}=; Path=/; Max-Age=0`);
}

/**
 * GET /api/auth/login
 * Kicks off "Sign in with Webflow" -- a `state` value guards the callback
 * against CSRF (an attacker can't forge a callback with a state they never
 * saw, since it's tied to a cookie only the real browser holds).
 */
router.get("/login", (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString("hex");
    setCookie(res, OAUTH_STATE_COOKIE, state, { maxAgeMs: OAUTH_STATE_MAX_AGE_MS });
    res.redirect(webflowOAuth.buildAuthorizeUrl(state));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/auth/callback
 * Exchanges the authorization code, identifies the user and which
 * Webflow site(s) they're authorizing, resolves that to an existing
 * account (or creates a new one -- see store.getAccountByWebflowSiteId's
 * dedup-by-site-id, which is also exactly what makes a second teammate on
 * the same site land in the same account), and establishes a session.
 */
router.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  const cookies = parseCookies(req.headers.cookie);

  if (!state || !cookies[OAUTH_STATE_COOKIE] || state !== cookies[OAUTH_STATE_COOKIE]) {
    return res.status(400).json({ error: "Invalid or expired OAuth state -- please try signing in again" });
  }
  clearCookie(res, OAUTH_STATE_COOKIE);

  if (!code) {
    return res.status(400).json({ error: "Missing authorization code" });
  }

  try {
    const tokenResponse = await webflowOAuth.exchangeCodeForToken(code);
    const accessToken = tokenResponse.access_token;
    if (!accessToken) {
      throw new Error("Webflow did not return an access token");
    }

    const [introspection, authorizedUser] = await Promise.all([
      webflowOAuth.introspectToken(accessToken),
      webflowOAuth.getAuthorizedUser(accessToken),
    ]);

    const siteIds = introspection?.authorization?.authorizedTo?.siteIds || [];
    if (siteIds.length === 0) {
      return res.status(400).json({ error: "This Webflow authorization didn't grant access to any site" });
    }

    const user = await store.upsertUser({
      webflowUserId: authorizedUser.id,
      email: authorizedUser.email,
      firstName: authorizedUser.firstName,
      lastName: authorizedUser.lastName,
    });

    // One grant can in principle cover more than one site (Webflow's
    // consent screen allows selecting several) -- resolve/create an
    // account per site, membership for all of them, land the session on
    // the first. A user with more than one account gets an account
    // switcher (GET /api/auth/me returns the full list).
    let primaryAccount = null;
    for (const siteId of siteIds) {
      let account = await store.getAccountByWebflowSiteId(siteId);
      if (!account) {
        account = await store.createAccount({ webflowSiteId: siteId });
      }
      const role = (await store.listAccountsForUser(user.id)).length === 0 ? "owner" : "member";
      await store.upsertAccountMembership(account.id, user.id, role);
      if (!primaryAccount) primaryAccount = account;

      // Stored for Phase 2 (see the plan file) -- not consumed for any API
      // call yet, but recording it now avoids re-prompting this user for a
      // second OAuth consent once Phase 2 starts using per-account tokens.
      const { ciphertext: accessTokenCiphertext, iv: accessTokenIv } = tokenCrypto.encrypt(accessToken);
      const refreshToken = tokenResponse.refresh_token;
      const encryptedRefresh = refreshToken ? tokenCrypto.encrypt(refreshToken) : null;
      await store.upsertWebflowConnection(account.id, {
        webflowSiteId: siteId,
        accessTokenCiphertext,
        accessTokenIv,
        refreshTokenCiphertext: encryptedRefresh?.ciphertext || null,
        refreshTokenIv: encryptedRefresh?.iv || null,
        scope: introspection?.authorization?.scope || null,
        authorizationId: introspection?.authorization?.id || null,
        connectedByUserId: user.id,
      });
    }

    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
    const sessionId = await store.createSession(user.id, primaryAccount.id, expiresAt);
    setCookie(res, SESSION_COOKIE_NAME, sessionId, { maxAgeMs: SESSION_MAX_AGE_MS });

    res.redirect("/");
  } catch (err) {
    console.error("OAuth callback failed:", err.response?.data || err.message);
    res.status(502).json({ error: "Sign-in failed. Please try again." });
  }
});

/**
 * POST /api/auth/logout
 */
router.post("/logout", async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (sessionId) await store.deleteSession(sessionId);
  clearCookie(res, SESSION_COOKIE_NAME);
  res.json({ loggedOut: true });
});

/**
 * GET /api/auth/me
 * Not behind requireSession (that middleware 401s outright) -- this route
 * needs to distinguish "not logged in" (a normal, expected state the
 * frontend checks on every load) from an error, so it does its own lookup
 * and returns null fields instead of a hard failure.
 */
router.get("/me", async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return res.json({ user: null, account: null, accounts: [] });

  const session = await store.getSessionWithUserAndAccount(sessionId);
  if (!session) return res.json({ user: null, account: null, accounts: [] });

  const accounts = await store.listAccountsForUser(session.user.id);
  res.json({ user: session.user, account: session.account, accounts });
});

module.exports = router;
