// Reads settings from environment variables (loaded from .env by dotenv in server.js).
// Fails fast at startup if a required secret is missing, instead of failing on the first request.

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

function loadConfig() {
  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long');
  }
  return {
    port: Number(process.env.PORT) || 3000,
    databaseUrl: required('DATABASE_URL'),
    jwtSecret,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
    // A vehicle whose last GPS ping is older than this is not offered for new jobs
    locationMaxAgeMinutes: Number(process.env.LOCATION_MAX_AGE_MINUTES) || 15,
    autoAssignRadiusKm: Number(process.env.AUTO_ASSIGN_RADIUS_KM) || 25,
  };
}

module.exports = { loadConfig };
