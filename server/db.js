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
}

module.exports = { query, migrate, pool };
