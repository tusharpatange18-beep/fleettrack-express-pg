// Starts a real PostgreSQL server for local development without installing anything system-wide.
// The `embedded-postgres` package ships the official PostgreSQL binaries inside node_modules.
// Data is kept in ./.pgdata between runs. Stop with Ctrl+C.
//
// If you have PostgreSQL installed (or use Docker / a cloud database), you don't need this:
// just point DATABASE_URL at it.
const path = require('node:path');
const fs = require('node:fs');
const EmbeddedPostgres = require('embedded-postgres').default;

const PORT = 5433;
const DATABASE = 'fleettrack';
const dataDir = path.join(__dirname, '..', '.pgdata');

(async () => {
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres', // local development only
    port: PORT,
    persistent: true,
    // UTF8 regardless of the OS default (Windows would otherwise pick WIN1252)
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    console.log('First run: initialising a new database cluster in .pgdata ...');
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase(DATABASE);
    console.log(`Created database "${DATABASE}"`);
  } catch {
    // already exists
  }
  console.log(`\nPostgreSQL is running.\nDATABASE_URL=postgres://postgres:postgres@localhost:${PORT}/${DATABASE}\n`);
  console.log('Leave this window open. Press Ctrl+C to stop.');

  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch(err => {
  console.error('Could not start PostgreSQL:', err.message);
  process.exit(1);
});
