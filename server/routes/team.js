const express = require("express");
const store = require("../store");
const { requireOwner } = require("../middleware/auth");

const router = express.Router();

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

module.exports = router;
