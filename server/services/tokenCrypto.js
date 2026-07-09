/**
 * AES-256-GCM encrypt/decrypt for `webflow_connections`'s stored OAuth
 * tokens -- these are real credentials that grant API access to a
 * customer's Webflow site, so they're never stored in plaintext, even
 * though nothing reads them for real API calls yet (that's Phase 2).
 *
 * Key comes from TOKEN_ENCRYPTION_KEY (32 random bytes, base64-encoded),
 * generated once and set as a Render env var -- never derived/guessable,
 * and never committed. Rotating it would make every already-stored token
 * undecryptable, so treat it like any other production secret (Phase 2
 * concern: a real re-auth flow if it's ever lost/rotated).
 */

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";

function getKey() {
  const keyB64 = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyB64) throw new Error("TOKEN_ENCRYPTION_KEY is not configured");
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length})`);
  }
  return key;
}

/**
 * Returns { ciphertext, iv } as Buffers, ready to store directly in the
 * BYTEA columns -- the GCM auth tag is appended to the ciphertext so only
 * one column is needed per value instead of three.
 */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([encrypted, authTag]), iv };
}

function decrypt(ciphertext, iv) {
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

module.exports = { encrypt, decrypt };
