/**
 * Small in-memory sliding-window limiter for routes/connect.js's public
 * invite-check/redeem endpoints -- this app has no rate-limiting library or
 * shared cache today, so this follows the same "acceptable in-memory
 * state" philosophy as store.js's syncJobs Map rather than adding a new
 * dependency. Deliberately process-local and best-effort: fine for the
 * current single free-tier Render instance (see render.yaml), but would
 * need a shared store (e.g. Redis) if this app ever runs more than one
 * instance. Requires app.set("trust proxy", ...) upstream (see index.js)
 * so req.ip reflects the real client behind Render's proxy.
 */

function createRateLimiter({ windowMs, max }) {
  const hitsByKey = new Map();

  return function rateLimiter(req, res, next) {
    const key = req.ip;
    const now = Date.now();
    const recent = (hitsByKey.get(key) || []).filter((t) => now - t < windowMs);

    if (recent.length >= max) {
      hitsByKey.set(key, recent);
      return res.status(429).json({ error: "rate_limited", message: "Too many attempts. Please try again later." });
    }

    recent.push(now);
    hitsByKey.set(key, recent);
    next();
  };
}

module.exports = { createRateLimiter };
