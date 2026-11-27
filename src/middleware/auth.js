const jwt = require('jsonwebtoken');
const db = require('../db/pool');
const { unauthorized, forbidden } = require('../errors');

const BEARER_PREFIX = 'Bearer ';
const BAD_TOKEN_MESSAGE = 'Missing, invalid or expired token';

/**
 * Reads "Authorization: Bearer <token>", verifies the signature and expiry, and loads the user.
 * Loading the user (rather than trusting the role inside the token) means a deleted account or
 * a changed role takes effect immediately, at the cost of one indexed lookup per request.
 *
 * optional = true: a request without a token is allowed through (used by /register).
 */
function authenticate(jwtSecret, options = {}) {
  const optional = options.optional === true;

  return async function checkToken(req, res, next) {
    let header = req.get('Authorization');
    if (!header) {
      header = '';
    }

    // No token at all
    if (!header.startsWith(BEARER_PREFIX)) {
      if (optional) {
        return next();
      }
      throw unauthorized(BAD_TOKEN_MESSAGE);
    }

    // jwt.verify checks the signature and the expiry; it throws if either is wrong
    const token = header.slice(BEARER_PREFIX.length);
    let payload;
    try {
      payload = jwt.verify(token, jwtSecret);
    } catch {
      throw unauthorized(BAD_TOKEN_MESSAGE);
    }

    // payload.sub is the user id we put in the token at login
    const { rows } = await db.query('SELECT id, username, role FROM users WHERE id = $1', [payload.sub]);
    if (rows.length === 0) {
      throw unauthorized(BAD_TOKEN_MESSAGE); // the account was deleted
    }
    req.user = rows[0]; // later handlers can read req.user.role
    next();
  };
}

/**
 * 403 unless the logged-in user has one of the given roles. Use after authenticate().
 * Example: requireRole('ADMIN', 'DISPATCHER')
 */
function requireRole(...roles) {
  return function checkRole(req, res, next) {
    if (!roles.includes(req.user.role)) {
      throw forbidden('Your role is not allowed to access this resource');
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
