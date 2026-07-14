/**
 * scrypt-based password hashing for users created via routes/connect.js's
 * invite redemption (the only users without any OAuth fallback -- Webflow
 * re-auth is every other user's way back in). Node's built-in `crypto`,
 * same philosophy as tokenCrypto.js -- no new dependency for something
 * this codebase can already do safely with what's built in. scrypt is a
 * memory-hard KDF (unlike a plain hash), which is what makes this safe to
 * use directly rather than needing bcrypt/argon2.
 */

const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

const KEY_LENGTH = 64;
const MIN_PASSWORD_LENGTH = 12;

function isPasswordValid(password) {
  return typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH;
}

/**
 * Returns a single string ("saltHex:hashHex") so it fits in one TEXT
 * column -- the salt doesn't need to be secret, just unique per password.
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

/**
 * Constant-time comparison (crypto.timingSafeEqual) so a mistyped password
 * can't be distinguished by how long the comparison took.
 */
async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scrypt(password, salt, expected.length);
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

module.exports = { hashPassword, verifyPassword, isPasswordValid, MIN_PASSWORD_LENGTH };
