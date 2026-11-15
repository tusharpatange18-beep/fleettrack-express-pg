const { Pool, types } = require('pg');

// Postgres BIGINT (type id 20) can exceed JavaScript's safe integer range, so `pg` returns it
// as a string by default. Our ids and COUNT(*) results stay far below 2^53, so parse them to
// numbers to get clean JSON ({"id": 1} instead of {"id": "1"}).
types.setTypeParser(20, value => Number.parseInt(value, 10));

let pool = null;

/**
 * A pool keeps a few open connections and lends one to each query, instead of opening a new
 * TCP connection (and Postgres backend process) per request, which would be slow.
 */
function initPool(databaseUrl) {
  pool = new Pool({ connectionString: databaseUrl, max: 10 });
  // An idle connection can fail (e.g. the database restarted); log instead of crashing
  pool.on('error', err => console.error('Idle Postgres client error:', err.message));
  return pool;
}

function getPool() {
  if (!pool) throw new Error('Database pool not initialised; call initPool() first');
  return pool;
}

/** Shorthand for a single query outside a transaction. */
function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Runs `work(client)` inside BEGIN ... COMMIT on ONE connection. If `work` throws, everything is
 * rolled back. All queries of a transaction must use the same client: the pool could otherwise
 * send them to different connections, which would be different transactions.
 */
async function withTransaction(work) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release(); // always hand the connection back to the pool
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { initPool, getPool, query, withTransaction, closePool };
