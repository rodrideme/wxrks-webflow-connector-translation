const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render's managed Postgres requires SSL; local dev connections don't use it.
  ssl: process.env.DATABASE_URL?.includes("render.com") ? { rejectUnauthorized: false } : false,
});

function query(text, params) {
  return pool.query(text, params);
}

/**
 * Idempotent schema setup, run once at server startup. `app_state` is a
 * generic key-value table for singleton state (settings, lastSync);
 * `project_mappings` is a real table since it's naturally list-shaped and
 * queried by recency.
 */
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_mappings (
      wxrks_project_uuid TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      source_locale TEXT,
      target_locales JSONB NOT NULL DEFAULT '[]',
      org_unit_uuid TEXT,
      work_unit_name_pattern TEXT,
      collection_ids JSONB NOT NULL DEFAULT '[]',
      items JSONB NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'in_progress',
      wxrks_status TEXT NOT NULL DEFAULT 'DRAFT',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updates JSONB NOT NULL DEFAULT '[]'
    )
  `);

  // Forward migration for tables created before the `updates` column existed.
  await pool.query(`ALTER TABLE project_mappings ADD COLUMN IF NOT EXISTS updates JSONB NOT NULL DEFAULT '[]'`);

  // Forward migration: attribution for project_mappings created by an
  // automation run. Not a foreign key -- automations are deletable and
  // history must stay attributable after deletion.
  await pool.query(`ALTER TABLE project_mappings ADD COLUMN IF NOT EXISTS automation_name TEXT`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      content_scope JSONB NOT NULL,
      flush_times JSONB NOT NULL DEFAULT '["00:00","12:00"]',
      org_unit_override TEXT,
      checkpoint JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Forward migration: the "Sync Panel - Ledger" redesign replaces
  // flush_times (a bare list of daily clock times) with `cadence` (a
  // richer {kind: hourly|daily|weekly, ...} shape supporting a weekly
  // schedule, which flush_times alone couldn't express), and adds real
  // per-automation workflow-step / project-name / first-run-backfill /
  // archived-state fields that were previously only global (or nonexistent).
  await pool.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS cadence JSONB`);
  await pool.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS workflows JSONB NOT NULL DEFAULT '["TRANSLATION"]'`);
  await pool.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS project_name TEXT`);
  await pool.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS include_existing BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false`);

  // Mirrors org_unit_override: lets an automation pin its own target
  // locales instead of always following the account's stored default (see
  // the wizard's Settings step, which now actually sends this instead of
  // silently discarding whatever the user picked there).
  await pool.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS target_locales_override JSONB`);

  // Multi-user login (Phase 1): one row per connected Webflow site -- the
  // tenancy boundary every other table gets scoped under. IDs are app-
  // generated TEXT (crypto.randomUUID()), matching this file's existing
  // convention (see `automations.id`), not native Postgres UUID/
  // gen_random_uuid() -- no reason to add that dependency when the existing
  // pattern already works.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT,
      webflow_site_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // One row per human who has ever logged in, identified by Webflow's own
  // stable user id (not email -- email could change).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      webflow_user_id TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Membership: which users can access which account(s) -- this is what
  // makes "multiple users, same account" work (see store.js's
  // upsertAccountForWebflowSite). Flat role only, no fine-grained RBAC yet.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_users (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, user_id)
    )
  `);

  // Server-side session store -- the cookie holds only this opaque id, so a
  // session can be killed instantly (one DELETE) without needing a JWT
  // blocklist.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Per-account Webflow OAuth grant. Populated at login time (Phase 1) even
  // though nothing reads it for real API calls yet (that's Phase 2, once
  // webflow.js's client() becomes per-account) -- storing it now avoids
  // re-prompting existing users for a second OAuth consent later.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webflow_connections (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      webflow_site_id TEXT NOT NULL,
      access_token_ciphertext BYTEA NOT NULL,
      access_token_iv BYTEA NOT NULL,
      refresh_token_ciphertext BYTEA,
      refresh_token_iv BYTEA,
      scope TEXT,
      authorization_id TEXT,
      connected_by_user_id TEXT REFERENCES users(id),
      connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_verified_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'active'
    )
  `);

  // Per-account wxrks credentials (Phase 3). No refresh-token concept --
  // wxrks sessions just re-authenticate with the same accessKey/secret when
  // the cached session token expires. No api_url column either: every
  // account is assumed to sit on the same shared WXRKS_API_URL platform,
  // only credentials + org unit (settings.orgUnitUUID) differ per client.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wxrks_connections (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      access_key_ciphertext BYTEA NOT NULL,
      access_key_iv BYTEA NOT NULL,
      secret_ciphertext BYTEA NOT NULL,
      secret_iv BYTEA NOT NULL,
      connected_by_user_id TEXT REFERENCES users(id),
      connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'active'
    )
  `);

  // Optional, per-account LLM API key used only as a fallback for
  // slugHandling's "transliterate" mode, for scripts the built-in
  // Cyrillic/Greek map can't handle (CJK, Arabic, Hebrew, etc.) -- see
  // services/transliterationLlm.js. Entirely unused unless an account both
  // opts into transliteration AND connects a key here; every other
  // slugHandling mode never touches this table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS llm_connections (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      api_key_ciphertext BYTEA NOT NULL,
      api_key_iv BYTEA NOT NULL,
      connected_by_user_id TEXT REFERENCES users(id),
      connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'active'
    )
  `);

  // Every pre-existing table becomes account-scoped. Nullable for now (not
  // NOT NULL) since existing rows predate accounts entirely --
  // migrateSingleTenantToAccountOne() (index.js) backfills them at startup
  // right after this migrate() call, immediately before anything reads them.
  await pool.query(`ALTER TABLE app_state ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES accounts(id)`);
  await pool.query(`ALTER TABLE project_mappings ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES accounts(id)`);
  await pool.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES accounts(id)`);
}

module.exports = { query, migrate, pool };
