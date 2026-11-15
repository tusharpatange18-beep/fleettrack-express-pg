// Minimal migration runner: applies migrations/NNN_name.sql files in order, once each.
// Applied versions are recorded in schema_migrations, so running it again is safe.
// Usage: npm run migrate
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

async function migrate(databaseUrl, { log = console.log } = {}) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(r => r.version));

    // Zero-padded names (001_, 002_) sort correctly as plain strings
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      // Each file runs in its own transaction: Postgres supports transactional DDL, so a
      // failing migration leaves no half-created tables behind.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`Applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.end();
  }
}

module.exports = { migrate };

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  migrate(process.env.DATABASE_URL)
    .then(() => console.log('Migrations up to date'))
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}
