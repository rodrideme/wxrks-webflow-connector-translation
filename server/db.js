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
}

module.exports = { query, migrate, pool };
