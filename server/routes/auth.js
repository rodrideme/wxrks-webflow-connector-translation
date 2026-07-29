const crypto = require("crypto");
const express = require("express");
const store = require("../store");
const webflowOAuth = require("../services/webflowOAuth");
const tokenCrypto = require("../services/tokenCrypto");
const passwordHash = require("../services/passwordHash");
const email = require("../services/email");
const { createRateLimiter } = require("../middleware/rateLimit");
const { SESSION_COOKIE_NAME, parseCookies, requireSession, deleteSessionFromRequestCookie } = require("../middleware/auth");

const router = express.Router();

// Defense-in-depth on top of password/token entropy -- see
// middleware/rateLimit.js's docblock for why this is process-local/best-effort.
const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const forgotPasswordLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });
const resetPasswordLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const PASSWORD_RESET_TOKEN_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour -- see store.createPasswordResetToken

const OAUTH_STATE_COOKIE = "oauth_state";
// 30 days, hard expiry from creation -- NOT sliding despite middleware/auth.js's
// touchSession firing on every request; that only bumps last_seen_at for
// display, never expires_at. A real fix, if wanted later, is separate from
// today's change (see routes/auth.js's login/reset-password routes below).
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_MAX_AGE_MS = 5 * 60 * 1000;

function isProd() {
  return process.env.NODE_ENV === "production" || Boolean(process.env.RENDER_GIT_COMMIT);
}

// Exported for reuse by routes/connect.js -- both this OAuth callback and
// that invite-redemption route create a session the exact same way.
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
  const { code, state, error, error_description: errorDescription } = req.query;
  const cookies = parseCookies(req.headers.cookie);

  // Webflow echoes the original `state` back even on an error redirect (no
  // code at all) -- e.g. the user declined the consent screen, or the app's
  // registration itself has a problem (bad redirect_uri, disabled scopes).
  // Surface *that* real reason instead of falling through to a generic
  // "missing code" message that hides what actually happened.
  if (error) {
    console.error("Webflow OAuth error redirect:", error, errorDescription);
    return res.status(400).json({ error: `Webflow declined the request: ${error}${errorDescription ? ` -- ${errorDescription}` : ""}` });
  }

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

    const [introspection, authorizedUser, authorizedSites] = await Promise.all([
      webflowOAuth.introspectToken(accessToken),
      webflowOAuth.getAuthorizedUser(accessToken),
      // Names only -- login must not fail because this listing did.
      webflowOAuth.listAuthorizedSites(accessToken).catch(() => []),
    ]);
    const siteNameById = new Map(authorizedSites.map((s) => [s.id, s.displayName || s.shortName || null]));

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
    // account per site, membership for all of them. Which account the
    // session lands on is decided AFTER the loop (see below); this
    // snapshot of pre-callback memberships is what lets it tell "a site
    // this login just connected" apart from "a site re-listed by the
    // cumulative grant".
    const membershipIdsBefore = new Set((await store.listAccountsForUser(user.id)).map((a) => a.id));
    const newlyLinkedAccounts = [];
    let primaryAccount = null;
    for (const siteId of siteIds) {
      const siteName = siteNameById.get(siteId) || null;
      let account = await store.getAccountByWebflowSiteId(siteId);
      if (!account) {
        account = await store.createAccount({ webflowSiteId: siteId, name: siteName });
      } else if (siteName && siteName !== account.name) {
        // Refresh on every login -- the site can be renamed on Webflow's
        // side, and the switcher/picker read accounts.name.
        await store.setAccountName(account.id, siteName);
        account = { ...account, name: siteName };
      }
      if (!membershipIdsBefore.has(account.id)) newlyLinkedAccounts.push(account);
      // Owner of any account you're the FIRST member of -- a per-account
      // check, not "is this your first account ever": a returning user
      // authorizing a brand-new site used to land as mere `member` of an
      // account nobody owned. upsertAccountMembership is ON CONFLICT DO
      // NOTHING, so an existing membership never changes role here.
      const role = (await store.listAccountMembers(account.id)).length === 0 ? "owner" : "member";
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

    // Which account does this session land on? `authorizedTo.siteIds` is
    // the CUMULATIVE grant -- every site this user ever authorized, with
    // NO field marking what they just picked on this consent pass (and on
    // a re-auth Webflow may skip the consent screen entirely) -- so
    // siteIds order carries no intent signal at all; blindly landing on
    // siteIds[0] was the "logged into site B, landed back in site A" bug.
    // What this callback CAN know: which sites became connected to this
    // user during THIS login. Exactly one newly linked account is an
    // unambiguous "this is what I came for" (first-time connects, a fresh
    // reconnect after an environment reset, a reviewer's install) -- land
    // straight on it. Anything else with multiple memberships is genuinely
    // ambiguous: land provisionally on siteIds[0] (a verified membership
    // either way) and send them to the in-app picker, whose
    // switch-account call re-points the session. The session must exist
    // before the redirect -- /select-site lists accounts via /api/auth/me.
    const landingAccount = newlyLinkedAccounts.length === 1 ? newlyLinkedAccounts[0] : primaryAccount;

    await deleteSessionFromRequestCookie(req);
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
    const sessionId = await store.createSession(user.id, landingAccount.id, expiresAt);
    setCookie(res, SESSION_COOKIE_NAME, sessionId, { maxAgeMs: SESSION_MAX_AGE_MS });

    const memberships = await store.listAccountsForUser(user.id);
    const needsPicker = newlyLinkedAccounts.length !== 1 && memberships.length > 1;
    res.redirect(needsPicker ? "/select-site" : "/");
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
 * POST /api/auth/login
 * body: { email, password }
 * The password counterpart to OAuth login -- only ever succeeds for users
 * created via routes/connect.js's invite redemption, since only they have
 * a password_hash set (see store.getUserForLogin). Always the same
 * generic error on any failure (unknown email, no password set, or wrong
 * password) so this can never be used to enumerate registered emails.
 */
router.post("/login", loginLimiter, async (req, res) => {
  const { email: loginEmail, password } = req.body || {};
  const genericError = { error: "Incorrect email or password." };
  if (!loginEmail || !password) return res.status(400).json(genericError);

  try {
    const user = await store.getUserForLogin(loginEmail);
    const valid = user ? await passwordHash.verifyPassword(password, user.passwordHash) : false;
    if (!valid) return res.status(401).json(genericError);

    const accounts = await store.listAccountsForUser(user.id);
    if (accounts.length === 0) return res.status(401).json(genericError);

    await deleteSessionFromRequestCookie(req);
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
    const sessionId = await store.createSession(user.id, accounts[0].id, expiresAt);
    setCookie(res, SESSION_COOKIE_NAME, sessionId, { maxAgeMs: SESSION_MAX_AGE_MS });
    res.json({ ok: true });
  } catch (err) {
    console.error("Password login failed:", err.message);
    res.status(502).json({ error: "Something went wrong. Please try again." });
  }
});

/**
 * POST /api/auth/forgot-password
 * body: { email }
 * Always responds the same way whether or not the email matches a real,
 * password-enabled account -- never reveals which emails are registered.
 * Only users with a password_hash are eligible (OAuth-only users have
 * nothing to reset here; Webflow re-auth is their way back in).
 */
router.post("/forgot-password", forgotPasswordLimiter, async (req, res) => {
  const { email: targetEmail } = req.body || {};
  const genericResponse = { ok: true, message: "If that email has password access enabled, we've sent a reset link." };
  if (!targetEmail) return res.json(genericResponse);

  try {
    const user = await store.getUserForLogin(targetEmail);
    if (user) {
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_MAX_AGE_MS);
      const token = await store.createPasswordResetToken(user.id, expiresAt);
      const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
      const resetUrl = `${baseUrl}/reset-password?token=${token}`;
      // Logged, not surfaced to the caller -- a broken email integration is
      // an operational problem for whoever runs this app, not something a
      // requester should learn about (that alone would confirm the email
      // was found, defeating the point of this generic response).
      await email.sendPasswordResetEmail(user.email, resetUrl).catch((err) => {
        console.error("Failed to send password reset email:", err.response?.data || err.message);
      });
    }
    res.json(genericResponse);
  } catch (err) {
    console.error("Forgot-password request failed:", err.message);
    res.json(genericResponse);
  }
});

/**
 * POST /api/auth/reset-password
 * body: { token, newPassword }
 * Also invalidates every other active session for this user (see
 * store.deleteSessionsForUser) -- if a password needed resetting, prior
 * sessions shouldn't be trusted to survive it. Auto-logs in with a fresh
 * session afterward, same as a successful invite redemption does.
 */
router.post("/reset-password", resetPasswordLimiter, async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !passwordHash.isPasswordValid(newPassword)) {
    return res.status(400).json({ error: `Password must be at least ${passwordHash.MIN_PASSWORD_LENGTH} characters.` });
  }

  try {
    const userId = await store.markPasswordResetTokenUsed(token);
    if (!userId) {
      return res.status(400).json({ error: "This reset link is invalid or has expired." });
    }

    await store.setUserPassword(userId, await passwordHash.hashPassword(newPassword));
    await store.deleteSessionsForUser(userId);

    const accounts = await store.listAccountsForUser(userId);
    if (accounts.length === 0) {
      return res.status(502).json({ error: "Password reset, but no connected account was found. Please contact whoever manages your connection." });
    }
    // deleteSessionsForUser above only covered THIS user's rows -- on a
    // shared browser the cookie can still reference a different user's
    // live session, which would otherwise be orphaned here.
    await deleteSessionFromRequestCookie(req);
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
    const sessionId = await store.createSession(userId, accounts[0].id, expiresAt);
    setCookie(res, SESSION_COOKIE_NAME, sessionId, { maxAgeMs: SESSION_MAX_AGE_MS });
    res.json({ ok: true });
  } catch (err) {
    console.error("Password reset failed:", err.message);
    res.status(502).json({ error: "Something went wrong. Please try again." });
  }
});

/**
 * POST /api/auth/set-password
 * body: { newPassword }
 * Requires an existing session (unlike login/forgot/reset-password, which
 * all create one) -- lets an already-logged-in, token-connected user set
 * or change their password from Settings. Restricted to accounts with no
 * OAuth identity: routes/connect.js prefixes a synthetic `manual:` id onto
 * webflowUserId for exactly this reason -- an OAuth-connected user always
 * already has a working way back in (Webflow re-auth) and was deliberately
 * excluded from this feature (see the plan this was built from).
 */
router.post("/set-password", requireSession, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!req.user.webflowUserId.startsWith("manual:")) {
    return res.status(403).json({ error: "This account signs in with Webflow directly and doesn't use a password." });
  }
  if (!passwordHash.isPasswordValid(newPassword)) {
    return res.status(400).json({ error: `Password must be at least ${passwordHash.MIN_PASSWORD_LENGTH} characters.` });
  }

  try {
    await store.setUserPassword(req.user.id, await passwordHash.hashPassword(newPassword));
    // Same reasoning as reset-password: don't leave other sessions trusted
    // after a password change, but keep THIS browser logged in with a
    // fresh session rather than logging the requester out mid-action.
    await store.deleteSessionsForUser(req.user.id);
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
    const sessionId = await store.createSession(req.user.id, req.account.id, expiresAt);
    setCookie(res, SESSION_COOKIE_NAME, sessionId, { maxAgeMs: SESSION_MAX_AGE_MS });
    res.json({ ok: true });
  } catch (err) {
    console.error("Set-password failed:", err.message);
    res.status(502).json({ error: "Something went wrong. Please try again." });
  }
});

/**
 * POST /api/auth/switch-account
 * body: { accountId }
 * Re-points this browser at another account the user is a member of --
 * used by the post-OAuth site picker (see the callback's redirect above)
 * and the sidebar switcher. Deletes the old session row and issues a
 * fresh one rather than UPDATE-ing sessions.account_id in place:
 * store.js already has exactly these two primitives, rotating the session
 * id on a privilege-context change is standard fixation hygiene, and
 * delete-then-create can never leave two live rows even if it dies
 * mid-sequence (it fails closed to a re-login). The 30-day expiry
 * restarting is the same thing any login does.
 */
router.post("/switch-account", requireSession, async (req, res) => {
  const { accountId } = req.body || {};
  if (!accountId) return res.status(400).json({ error: "accountId is required" });

  try {
    const accounts = await store.listAccountsForUser(req.user.id);
    const target = accounts.find((a) => a.id === accountId);
    if (!target) return res.status(403).json({ error: "You don't have access to that account." });

    await store.deleteSession(req.sessionId);
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
    const sessionId = await store.createSession(req.user.id, target.id, expiresAt);
    setCookie(res, SESSION_COOKIE_NAME, sessionId, { maxAgeMs: SESSION_MAX_AGE_MS });
    store.recordActivity(target.id, req.user.id, "account.switched", { fromAccountId: req.account.id }).catch(() => {});
    res.json({ ok: true, account: { id: target.id, name: target.name, webflowSiteId: target.webflowSiteId } });
  } catch (err) {
    console.error("Account switch failed:", err.message);
    res.status(502).json({ error: "Something went wrong. Please try again." });
  }
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
module.exports.setCookie = setCookie;
module.exports.SESSION_MAX_AGE_MS = SESSION_MAX_AGE_MS;
