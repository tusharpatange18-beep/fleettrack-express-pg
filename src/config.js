// Reads settings from environment variables (loaded from .env by dotenv in server.js).
// Fails fast at startup if a required secret is missing, instead of failing on the first request.

/** Returns the variable's value, or stops the app if it is missing. */
function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

/** Reads a number from an environment variable; uses the default if it is missing, 0 or not a number. */
function numberOrDefault(name, defaultValue) {
  const value = Number(process.env[name]);
  if (!value) {
    // Number(undefined) and Number('abc') are NaN, which counts as false here, like 0
    return defaultValue;
  }
  return value;
}

function loadConfig() {
  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long');
  }

  let jwtExpiresIn = '24h';
  if (process.env.JWT_EXPIRES_IN) {
    jwtExpiresIn = process.env.JWT_EXPIRES_IN;
  }

  return {
    port: numberOrDefault('PORT', 3000),
    databaseUrl: required('DATABASE_URL'),
    jwtSecret: jwtSecret,
    jwtExpiresIn: jwtExpiresIn,
    // A vehicle whose last GPS ping is older than this is not offered for new jobs
    locationMaxAgeMinutes: numberOrDefault('LOCATION_MAX_AGE_MINUTES', 15),
    autoAssignRadiusKm: numberOrDefault('AUTO_ASSIGN_RADIUS_KM', 25),
  };
}

module.exports = { loadConfig };
