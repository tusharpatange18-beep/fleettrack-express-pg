const jwt = require('jsonwebtoken');
const db = require('../db/pool');
const { unauthorized, forbidden } = require('../errors');

/**
 * Reads "Authorization: Bearer <token>", verifies the signature and expiry, and loads the user.
 * Loading the user (rather than trusting the role inside the token) means a deleted account or
 * a changed role takes effect immediately, at the cost of one indexed lookup per request.
 */
function authenticate(jwtSecret, { optional = false } = {}) {
  return async (req, res, next) => {
    const header = req.get('Authorization') || '';
    if (!header.startsWith('Bearer ')) {
      if (optional) return next();
      throw unauthorized('Missing, invalid or expired token');
    }
    let payload;
    try {
      payload = jwt.verify(header.slice('Bearer '.length), jwtSecret);
    } catch {
      throw unauthorized('Missing, invalid or expired token');
    }
    const { rows } = await db.query('SELECT id, username, role FROM users WHERE id = $1', [payload.sub]);
    if (rows.length === 0) throw unauthorized('Missing, invalid or expired token');
    req.user = rows[0];
    next();
  };
}

/** 403 unless the authenticated user has one of the given roles. Use after authenticate(). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      throw forbidden('Your role is not allowed to access this resource');
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
