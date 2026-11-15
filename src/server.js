require('dotenv').config({ quiet: true }); // load .env into process.env before anything reads it
const { loadConfig } = require('./config');
const db = require('./db/pool');
const { createApp } = require('./app');

const config = loadConfig();
db.initPool(config.databaseUrl);

const server = createApp(config).listen(config.port, () => {
  console.log(`FleetTrack API listening on http://localhost:${config.port}`);
});

// Graceful shutdown (Ctrl+C, or a container stop): stop accepting requests, let in-flight ones
// finish, then close the database pool.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await db.closePool();
      process.exit(0);
    });
  });
}
