// Runs once before all test files: starts a throwaway PostgreSQL, creates a database and applies
// the real migrations. Tests therefore run against the same schema as production, not a mock.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const EmbeddedPostgres = require('embedded-postgres').default;
const { migrate } = require('../src/db/migrate');

const PORT = 54330;

module.exports = async function globalSetup() {
  // CI (GitHub Actions) provides its own Postgres service through TEST_DATABASE_URL
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleettrack-test-pg-'));
    const pg = new EmbeddedPostgres({
      databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      onLog: () => {}, // keep test output quiet
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('fleettrack_test');
    globalThis.__EMBEDDED_PG__ = pg;
    process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${PORT}/fleettrack_test`;
  }
  await migrate(process.env.DATABASE_URL, { log: () => {} });
};
