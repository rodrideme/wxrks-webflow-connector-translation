/**
 * Public, invite-gated alternative to "Sign in with Webflow" OAuth
 * (routes/auth.js) -- lets someone from a workspace OAuth can never reach
 * (an unapproved OAuth app only ever authorizes its own registration
 * workspace, confirmed against Webflow's own developer forum) connect
 * using a manually-generated Webflow Site API token instead, gated behind
 * an invite an existing account owner generated (see routes/team.js's
 * /invites routes). Mounted in index.js alongside authRouter/webhooksRouter,
 * BEFORE requireSession -- this route creates a session, so it can't be
 * behind the middleware that requires one.
 */

const crypto = require("crypto");
const express = require("express");
const store = require("../store");
const tokenCrypto = require("../services/tokenCrypto");
const webflowManualToken = require("../services/webflowManualToken");
const passwordHash = require("../services/passwordHash");
const { createRateLimiter } = require("../middleware/rateLimit");
const { SESSION_COOKIE_NAME } = require("../middleware/auth");
const { setCookie, SESSION_MAX_AGE_MS } = require("./auth");

const router = express.Router();

// Defense-in-depth only -- the token's own entropy (256 bits, see
// store.js's createInvite) is the real defense, not this. See
// middleware/rateLimit.js's docblock for why this is process-local/
// best-effort and requires app.set("trust proxy", ...) upstream.
const checkLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const redeemLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

const EMAIL_RE = /^\S+@\S+\.\S+$/;

/**
 * GET /api/connect/invite/:token
 * Returns ONLY { valid: boolean } -- identical shape no matter WHY an
 * invite is dead (never existed / expired / redeemed / revoked / over the
 * failed-attempts cap), so probing random strings reveals nothing about
 * which ones ever corresponded to a real invite.
 */
router.get("/invite/:token", checkLimiter, async (req, res) => {
  try {
    const invite = await store.getInviteByToken(req.params.token);
    res.json({ valid: store.isInviteValid(invite) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/connect/redeem
 * body: { inviteToken, webflowApiToken, firstName, lastName?, email, password }
 *
 * password is required here (not optional, not set-later) -- this account
 * has no OAuth fallback at all, so a real, Webflow-independent password is
 * the only way back in once the session expires or the invite (already
 * single-use) is gone. See services/passwordHash.js.
 *
 * Ordering is deliberate:
 *  1. Cheap shape validation.
 *  2. Read-only invite check (no mutation yet).
 *  3. Live-validate the Webflow token BEFORE marking the invite used, so a
 *     typo never burns the redeemer's one-time invite.
 *  4. The one atomic single-use gate (race-safe under concurrent attempts
 *     against the same token -- see store.markInviteRedeemed).
 *  5. Resolve identity + create/find the user, account(s), membership(s),
 *     and Webflow connection(s) -- mirrors routes/auth.js's OAuth callback
 *     loop exactly, including its same unaddressed partial-failure risk if
 *     step 6 throws mid-loop (no transaction wraps either flow today).
 *  6. Session + cookie, same shape as the OAuth callback.
 */
router.post("/redeem", redeemLimiter, async (req, res) => {
  const { inviteToken, webflowApiToken, firstName, lastName, email, password } = req.body || {};

  if (!inviteToken || !webflowApiToken || !firstName || !email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "All fields are required, and email must look valid." });
  }
  if (!passwordHash.isPasswordValid(password)) {
    return res.status(400).json({ error: `Password must be at least ${passwordHash.MIN_PASSWORD_LENGTH} characters.` });
  }

  const invite = await store.getInviteByToken(inviteToken);
  if (!store.isInviteValid(invite)) {
    return res.status(400).json({ error: "This invite link is invalid or has expired." });
  }

  let sites;
  try {
    sites = await webflowManualToken.listSitesForToken(webflowApiToken);
  } catch (err) {
    store.incrementInviteFailedAttempts(invite.id).catch(() => {});
    return res.status(400).json({
      error: err.response?.data?.message || "Webflow rejected this token. Check that you copied it correctly and it has the required scopes.",
    });
  }
  if (sites.length === 0) {
    store.incrementInviteFailedAttempts(invite.id).catch(() => {});
    return res.status(400).json({ error: "This token doesn't grant access to any Webflow site." });
  }

  const redeemed = await store.markInviteRedeemed(inviteToken);
  if (!redeemed) {
    // Rare race: someone else redeemed the same link in the last few ms.
    return res.status(400).json({ error: "This invite link is invalid or has expired." });
  }

  try {
    // Identity: the form is authoritative; a live id is a bonus if this
    // token happens to support it (see webflowManualToken.js's docblock --
    // expected to fail for a genuine Site token, and that's fine).
    const authorizedUser = await webflowManualToken.tryResolveAuthorizedUser(webflowApiToken);
    const user = await store.upsertUser({
      webflowUserId: authorizedUser?.id || `manual:${crypto.randomUUID()}`,
      email,
      firstName,
      lastName: lastName || null,
    });
    await store.setUserPassword(user.id, await passwordHash.hashPassword(password));

    // Mirrors routes/auth.js's OAuth callback loop exactly: one account
    // per granted site, membership for all, land the session on the first.
    let primaryAccount = null;
    for (const site of sites) {
      let account = await store.getAccountByWebflowSiteId(site.id);
      if (!account) account = await store.createAccount({ webflowSiteId: site.id });
      const role = (await store.listAccountsForUser(user.id)).length === 0 ? "owner" : "member";
      await store.upsertAccountMembership(account.id, user.id, role);
      if (!primaryAccount) primaryAccount = account;

      const { ciphertext: accessTokenCiphertext, iv: accessTokenIv } = tokenCrypto.encrypt(webflowApiToken);
      await store.upsertWebflowConnection(account.id, {
        webflowSiteId: site.id,
        accessTokenCiphertext,
        accessTokenIv,
        refreshTokenCiphertext: null,
        refreshTokenIv: null, // no refresh concept for a manually-pasted static token
        scope: null,
        authorizationId: null, // no live introspection available for a Site token
        connectedByUserId: user.id,
      });
    }

    // Bookkeeping only -- not part of the security-critical gate above.
    store.attributeInviteRedemption(redeemed.id, { redeemedByUserId: user.id, redeemedAccountId: primaryAccount.id }).catch(() => {});
    store.recordActivity(primaryAccount.id, user.id, "invite.redeemed", {}).catch(() => {});

    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
    const sessionId = await store.createSession(user.id, primaryAccount.id, expiresAt);
    setCookie(res, SESSION_COOKIE_NAME, sessionId, { maxAgeMs: SESSION_MAX_AGE_MS });
    res.json({ ok: true });
  } catch (err) {
    // The invite is now burned with no working account -- rare (a DB error
    // mid-sequence), and mirrors the same class of unaddressed partial-
    // failure risk routes/auth.js's own OAuth callback already has today
    // for this identical multi-step sequence. Whoever sent the invite can
    // just generate a fresh one.
    console.error("Invite redemption failed after invite was marked used:", err.response?.data || err.message);
    res.status(502).json({ error: "Something went wrong finishing setup. Please contact whoever sent you this invite for a new link." });
  }
});

module.exports = router;
