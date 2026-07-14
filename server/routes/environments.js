/**
 * Lets this connector's own (original) account provision a brand-new,
 * fully separate environment for another company/workspace -- one this
 * app's "Sign in with Webflow" OAuth app can never reach on its own (an
 * unapproved OAuth app only ever authorizes its own registration
 * workspace). This is deliberately NOT part of team.js: the resulting
 * environment is a completely independent account with its own Webflow
 * connection, own settings, own members -- not a member added to THIS
 * account, so it doesn't belong next to Members/Activity Log. Gated by
 * requireOriginalAccount (see middleware/auth.js) -- only the operator
 * provisions new environments; a customer's own account owner shouldn't be
 * able to onboard other, unrelated companies into this system. See
 * routes/connect.js for the redemption side of this same mechanism.
 */

const express = require("express");
const store = require("../store");
const { requireOwner, requireOriginalAccount } = require("../middleware/auth");

const router = express.Router();
router.use(requireOriginalAccount);

function mask(value) {
  if (!value) return "";
  return value.length <= 4 ? "****" : `${value.slice(0, 2)}${"*".repeat(value.length - 4)}${value.slice(-2)}`;
}

const DEFAULT_INVITE_EXPIRY_DAYS = 7;

function environmentLinkStatus(invite) {
  if (invite.revokedAt) return "revoked";
  if (invite.redeemedAt) return "redeemed";
  if (new Date(invite.expiresAt) <= new Date()) return "expired";
  return "pending";
}

function toSummary(invite) {
  return {
    id: invite.id,
    tokenMasked: mask(invite.token),
    note: invite.note,
    status: environmentLinkStatus(invite),
    expiresAt: invite.expiresAt,
    redeemedAt: invite.redeemedAt,
    revokedAt: invite.revokedAt,
    createdAt: invite.createdAt,
  };
}

/**
 * POST /api/environments
 * body: { note?, expiresInDays? }
 * The full token/link is only ever returned by THIS response -- every
 * other read (GET below) only ever sees a masked token, so it must be
 * copied now.
 */
router.post("/", requireOwner, async (req, res) => {
  const { note } = req.body || {};
  const expiresInDays = Math.min(30, Math.max(1, parseInt(req.body?.expiresInDays, 10) || DEFAULT_INVITE_EXPIRY_DAYS));
  try {
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const invite = await store.createInvite(req.account.id, { kind: "environment", createdByUserId: req.user.id, note, expiresAt });
    store.recordActivity(req.account.id, req.user.id, "invite.create", {}).catch(() => {});
    res.json({ id: invite.id, token: invite.token, note: invite.note, expiresAt: invite.expiresAt, createdAt: invite.createdAt });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/environments
 * Never returns a full token -- see the POST route above.
 */
router.get("/", requireOwner, async (req, res) => {
  try {
    const invites = await store.listInvites(req.account.id, "environment");
    res.json({ environments: invites.map(toSummary) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/environments/:id/revoke
 * A no-op (per store.revokeInvite's own WHERE clause) if already
 * redeemed -- revoking can't undo an environment that already exists, only
 * prevent a still-pending link from being used.
 */
router.post("/:id/revoke", requireOwner, async (req, res) => {
  try {
    await store.revokeInvite(req.account.id, req.params.id, "environment");
    store.recordActivity(req.account.id, req.user.id, "invite.revoke", {}).catch(() => {});
    const invites = await store.listInvites(req.account.id, "environment");
    res.json({ environments: invites.map(toSummary) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
