const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/pool');
const { forbidden, unauthorized, conflict } = require('../errors');

// Cost factor 10 = 2^10 hashing rounds: slow enough to make brute force expensive,
// fast enough (~70 ms) for a login request.
const BCRYPT_ROUNDS = 10;

/**
 * Registers a user. New accounts default to DISPATCHER. ADMIN may only be created by an
 * existing admin, except the very first account, which bootstraps the system.
 * `caller` is the logged-in user making the request, or undefined if nobody is logged in.
 */
async function register(request, caller) {
  const username = request.username;
  let role = 'DISPATCHER';
  if (request.role) {
    role = request.role;
  }

  // Never store the password itself, only its bcrypt hash
  const passwordHash = await bcrypt.hash(request.password, BCRYPT_ROUNDS);

  return db.withTransaction(async function (client) {
    // Two "first users" registering at the same moment could both see count = 0 and both become
    // ADMIN. A transaction-scoped advisory lock serialises registrations: the second waits here
    // until the first commits. The lock is released automatically at COMMIT/ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock(1001)');

    if (role === 'ADMIN') {
      const { rows } = await client.query('SELECT COUNT(*) AS count FROM users');
      const isFirstUser = rows[0].count === 0;
      const callerIsAdmin = caller !== undefined && caller !== null && caller.role === 'ADMIN';
      if (!isFirstUser && !callerIsAdmin) {
        throw forbidden('Only an admin can create admin accounts');
      }
    }

    const existing = await client.query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (existing.rowCount > 0) {
      throw conflict(`Username already exists: ${username}`);
    }

    const { rows } = await client.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role',
      [username, passwordHash, role],
    );
    return rows[0];
  });
}

/** Returns a signed JWT for valid credentials. */
async function login(request, config) {
  const { rows } = await db.query('SELECT id, password_hash FROM users WHERE username = $1', [request.username]);
  const user = rows[0];

  // Same message for "no such user" and "wrong password", so attackers cannot probe usernames
  if (!user) {
    throw unauthorized('Invalid username or password');
  }
  // bcrypt hashes the typed password the same way and compares the two hashes
  const passwordMatches = await bcrypt.compare(request.password, user.password_hash);
  if (!passwordMatches) {
    throw unauthorized('Invalid username or password');
  }

  // `sub` (subject) is the standard JWT claim for "who this token is about"
  const token = jwt.sign({ sub: String(user.id) }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
  return { token: token };
}

module.exports = { register, login };
