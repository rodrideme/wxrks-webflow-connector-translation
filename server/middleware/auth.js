/**
 * Gates every /api/* route except /api/health, /api/auth/*, and
 * /api/webhooks/* (those are HMAC/signature-authenticated separately, not
 * session-authenticated -- see routes/webhooks.js). Reads the session
 * cookie, loads the session/user/account in one query, and attaches
 * req.user/req.account -- every route handler downstream reads
 * req.account.id to scope its store.js calls.
 */

const store = require("../store");
const accountContext = require("../services/accountContext");

const SESSION_COOKIE_NAME = "session_id";

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

async function requireSession(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) {
    return res.status(401).json({ error: "not_authenticated" });
  }

  const session = await store.getSessionWithUserAndAccount(sessionId);
  if (!session) {
    return res.status(401).json({ error: "not_authenticated" });
  }

  req.user = session.user;
  req.account = session.account;
  req.sessionId = session.sessionId;

  // Fire-and-forget -- a slightly-stale last_seen_at is harmless, and this
  // shouldn't add a write-then-wait to every single authenticated request.
  store.touchSession(sessionId).catch(() => {});

  // Establishes this request's account context for the entire remaining
  // async call chain (see services/accountContext.js's docstring) -- this
  // is what lets services/webflow.js's client()/siteId() resolve the right
  // account's own Webflow credentials without any other file needing to
  // know or pass accountId around.
  accountContext.run(req.account.id, next);
}

/**
 * Blocks every mutating route for a teammate an owner has set to
 * 'reviewer' (Teams page) -- Webflow's own API has no collaborator-role
 * data this app could gate on instead (see db.js's access_level column
 * comment), so this is the real enforcement boundary; the client only
 * disables the matching buttons for UX, it can't be trusted alone. Must
 * run after requireSession (reads req.account, set there).
 */
function requireWriteAccess(req, res, next) {
  if (req.account.accessLevel === "reviewer") {
    return res.status(403).json({ error: "read_only_access", message: "Your account has read-only access." });
  }
  next();
}

// Gates Teams-page membership management specifically -- independent of
// requireWriteAccess's accessLevel check (see store.js's
// getSessionWithUserAndAccount doc comment on why role/accessLevel are two
// separate axes).
function requireOwner(req, res, next) {
  if (req.account.role !== "owner") {
    return res.status(403).json({ error: "owner_only", message: "Only the account owner can manage team access." });
  }
  next();
}

module.exports = { requireSession, requireWriteAccess, requireOwner, SESSION_COOKIE_NAME, parseCookies };
