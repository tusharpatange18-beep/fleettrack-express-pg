const { HttpError } = require('../errors');

const REASONS = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  500: 'Internal Server Error',
};

// Postgres error codes (SQLSTATE) we translate into client errors. These fire when a database
// constraint catches something the code did not, e.g. two requests racing on the same unique value.
// Each entry is [HTTP status, message].
const PG_ERRORS = {
  23505: [409, 'The request conflicts with existing data (duplicate value)'],  // unique_violation
  23503: [409, 'The request refers to a record that does not exist'],          // foreign_key_violation
  23514: [400, 'A value is outside the allowed range'],                         // check_violation
  '22P02': [400, 'A value has the wrong format'],                               // invalid_text_representation
  '40P01': [409, 'The resource was modified concurrently; please retry'],       // deadlock_detected
  40001: [409, 'The resource was modified concurrently; please retry'],         // serialization_failure
};

// Friendlier messages for specific unique constraints, keyed by Postgres constraint name
const UNIQUE_MESSAGES = {
  users_username_key: 'Username already exists',
  vehicles_registration_number_key: 'A vehicle with this registration number already exists',
  drivers_phone_key: 'A driver with this phone number already exists',
  drivers_license_number_key: 'A driver with this license number already exists',
  vehicles_driver_id_key: 'Driver is already assigned to another vehicle',
  uq_deliveries_one_active_per_vehicle: 'Vehicle is already assigned to another active delivery',
};

/** The URL path without the "?query" part. */
function pathOf(req) {
  return req.originalUrl.split('?')[0];
}

/** 404 for any route that did not match. */
function notFoundHandler(req, res) {
  send(res, req, 404, `No endpoint ${req.method} ${pathOf(req)}`);
}

/**
 * Express recognises an error handler by its four arguments. Express 5 forwards errors thrown
 * in async handlers here automatically, so routes need no try/catch.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Our own errors (notFound, conflict, ...) already carry the right status
  if (err instanceof HttpError) {
    return send(res, req, err.status, err.message);
  }

  // Malformed JSON body (thrown by express.json())
  if (err.type === 'entity.parse.failed') {
    return send(res, req, 400, 'Malformed JSON body');
  }

  // A database constraint fired: turn the Postgres code into a 4xx
  if (err.code && PG_ERRORS[err.code]) {
    const status = PG_ERRORS[err.code][0];
    let message = PG_ERRORS[err.code][1];
    if (UNIQUE_MESSAGES[err.constraint]) {
      message = UNIQUE_MESSAGES[err.constraint]; // a more specific message for this constraint
    }
    return send(res, req, status, message);
  }

  // Anything else is a bug: log the details, but never leak internals to the client
  console.error(`Unexpected error at ${req.method} ${req.originalUrl}:`, err);
  send(res, req, 500, 'An unexpected error occurred');
}

/** Writes the standard JSON error body (same shape as the Java version). */
function send(res, req, status, message) {
  let error = REASONS[status];
  if (!error) {
    error = 'Error';
  }
  res.status(status).json({
    timestamp: new Date().toISOString(),
    status: status,
    error: error,
    message: message,
    path: pathOf(req),
  });
}

module.exports = { errorHandler, notFoundHandler };
