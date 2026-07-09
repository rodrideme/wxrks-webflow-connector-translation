/**
 * Gates every /api/* route except /api/health, /api/auth/*, and
 * /api/webhooks/* (those are HMAC/signature-authenticated separately, not
 * session-authenticated -- see routes/webhooks.js). Reads the session
 * cookie, loads the session/user/account in one query, and attaches
 * req.user/req.account -- every route handler downstream reads
 * req.account.id to scope its store.js calls.
 */

const store = require("../store");

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

  next();
}

module.exports = { requireSession, SESSION_COOKIE_NAME, parseCookies };
