const express = require("express");
const store = require("../store");
const email = require("../services/email");
const { requireOwner } = require("../middleware/auth");

const router = express.Router();

function mask(value) {
  if (!value) return "";
  return value.length <= 4 ? "****" : `${value.slice(0, 2)}${"*".repeat(value.length - 4)}${value.slice(-2)}`;
}

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const DEFAULT_TEAM_INVITE_EXPIRY_DAYS = 7;

function teamInviteStatus(invite) {
  if (invite.revokedAt) return "revoked";
  if (invite.redeemedAt) return "redeemed";
  if (new Date(invite.expiresAt) <= new Date()) return "expired";
  return "pending";
}

function toInviteSummary(invite) {
  return {
    id: invite.id,
    tokenMasked: mask(invite.token),
    note: invite.note,
    status: teamInviteStatus(invite),
    expiresAt: invite.expiresAt,
    redeemedAt: invite.redeemedAt,
    revokedAt: invite.revokedAt,
    createdAt: invite.createdAt,
  };
}

/**
 * GET /api/team
 * Everyone with access to this account, for the Teams page's member list.
 * Available to any authenticated member (including reviewers) -- seeing
 * who else has access isn't a write action.
 */
router.get("/", async (req, res) => {
  try {
    const members = await store.listAccountMembers(req.account.id);
    res.json({ members, currentUserId: req.user.id });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * PUT /api/team/:userId/access-level
 * body: { accessLevel: "full" | "reviewer" }
 * Owner-only (see middleware/auth.js's requireOwner) -- Webflow's own API
 * has no collaborator-role data this app could gate on instead (see
 * db.js's access_level column comment), so this is managed entirely
 * in-app. Rejects targeting the requester's own row: an owner downgrading
 * themselves with no one else able to undo it would be a self-inflicted
 * lockout, and this is the only place access level is ever changed.
 */
router.put("/:userId/access-level", requireOwner, async (req, res) => {
  const { accessLevel } = req.body || {};
  if (!["full", "reviewer"].includes(accessLevel)) {
    return res.status(400).json({ error: "accessLevel must be 'full' or 'reviewer'" });
  }
  if (req.params.userId === req.user.id) {
    return res.status(400).json({ error: "You can't change your own access level" });
  }
  try {
    await store.setAccountUserAccessLevel(req.account.id, req.params.userId, accessLevel);
    store.recordActivity(req.account.id, req.user.id, "team.access_level_update", { targetUserId: req.params.userId, accessLevel }).catch(() => {});
    const members = await store.listAccountMembers(req.account.id);
    res.json({ members, currentUserId: req.user.id });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/team/activity
 * query: { limit?, offset? }
 * Paginated log of every mutating action taken on this account, most
 * recent first. Read-only, so no requireWriteAccess -- reviewers can see
 * the log even though they can't add to it themselves.
 */
router.get("/activity", async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const items = await store.listActivity(req.account.id, { limit, offset });
    res.json({ items, hasMore: items.length === limit });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/team/invites
 * body: { email, expiresInDays? }
 * Lets this account's owner invite a plain teammate directly into THIS
 * account -- no Webflow API access required from them at all (see
 * routes/connect.js's "team_member" redeem branch). Unlike
 * routes/environments.js's invites, this never creates a new account; it
 * always resolves back to this same account at redemption. email is
 * stored in the invite's existing `note` column (reused as the recipient
 * label here rather than a free-text note -- no schema change needed) and
 * is who the invite link gets emailed to via services/email.js. The
 * response still includes the full token/link (never returned again by
 * the GET below, which only ever shows a masked token) so the owner can
 * also copy/share it directly -- e.g. if the email bounces or lands in
 * spam.
 */
router.post("/invites", requireOwner, async (req, res) => {
  const { email: inviteEmail } = req.body || {};
  if (!inviteEmail || !EMAIL_RE.test(inviteEmail)) {
    return res.status(400).json({ error: "A valid email is required." });
  }
  const expiresInDays = Math.min(30, Math.max(1, parseInt(req.body?.expiresInDays, 10) || DEFAULT_TEAM_INVITE_EXPIRY_DAYS));
  try {
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const invite = await store.createInvite(req.account.id, {
      kind: "team_member",
      createdByUserId: req.user.id,
      note: inviteEmail,
      expiresAt,
    });
    store.recordActivity(req.account.id, req.user.id, "team_invite.create", {}).catch(() => {});

    const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const inviteUrl = `${baseUrl}/connect?invite=${invite.token}`;
    let emailSent = true;
    try {
      await email.sendTeamInviteEmail(inviteEmail, inviteUrl);
    } catch (err) {
      // Not swallowed the way forgot-password's failures are -- there's no
      // anti-enumeration reason to hide this from an owner who just typed
      // this exact email in themselves. They need to know to share the
      // link manually instead.
      console.error("Failed to send team invite email:", err.response?.data || err.message);
      emailSent = false;
    }

    res.json({ id: invite.id, token: invite.token, note: invite.note, expiresAt: invite.expiresAt, createdAt: invite.createdAt, emailSent });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/team/invites
 * Owner-only. Never returns a full token -- see the POST route above.
 */
router.get("/invites", requireOwner, async (req, res) => {
  try {
    const invites = await store.listInvites(req.account.id, "team_member");
    res.json({ invites: invites.map(toInviteSummary) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/team/invites/:id/revoke
 * Owner-only. A no-op (per store.revokeInvite's own WHERE clause) if the
 * invite was already redeemed.
 */
router.post("/invites/:id/revoke", requireOwner, async (req, res) => {
  try {
    await store.revokeInvite(req.account.id, req.params.id, "team_member");
    store.recordActivity(req.account.id, req.user.id, "team_invite.revoke", {}).catch(() => {});
    const invites = await store.listInvites(req.account.id, "team_member");
    res.json({ invites: invites.map(toInviteSummary) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
