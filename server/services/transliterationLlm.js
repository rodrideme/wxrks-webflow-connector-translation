const axios = require("axios");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Haiku is plenty for a few-word transliteration and keeps this cheap/fast
// -- this only ever runs as a fallback for scripts the built-in Cyrillic/
// Greek map can't handle (CJK, Arabic, Hebrew, etc.), not on every item.
const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT =
  "You transliterate short text (a CMS item's name) into Latin-script, URL-slug-friendly text -- phonetic " +
  "romanization, not translation. Reply with ONLY the transliterated words separated by single spaces, lowercase, " +
  "no punctuation, no explanation. Example: '中文测试' -> 'zhong wen ce shi'.";

function headers(apiKey) {
  return { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" };
}

/**
 * Transliterates `text` via Anthropic's Messages API using this account's
 * own BYO API key (server/store.js's llm_connections). Returns raw model
 * output -- callers must still run it through webflow.sanitizeSlug() before
 * ever writing it as a Webflow slug, exactly like the built-in
 * transliterateToLatin() path; this function makes no validity guarantees
 * of its own.
 */
async function transliterateViaLlm(apiKey, text) {
  const res = await axios.post(
    ANTHROPIC_API_URL,
    { model: MODEL, max_tokens: 60, system: SYSTEM_PROMPT, messages: [{ role: "user", content: String(text || "") }] },
    { headers: headers(apiKey), timeout: 15000 }
  );
  return res.data?.content?.[0]?.text?.trim() || "";
}

/**
 * One-off validation call for the Settings UI, mirroring wxrks.js's
 * testCredentials -- an invalid key should never be silently saved.
 */
async function testApiKey(apiKey) {
  await axios.post(
    ANTHROPIC_API_URL,
    { model: MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
    { headers: headers(apiKey), timeout: 15000 }
  );
}

module.exports = { transliterateViaLlm, testApiKey };
