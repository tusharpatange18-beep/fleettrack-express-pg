// Shared test setup: one app + pool per test file, empty tables before every test,
// and small helpers that call the API the way a client would.
const request = require('supertest');
const db = require('../src/db/pool');
const { createApp } = require('../src/app');

const config = {
  port: 0,
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: 'test-secret-that-is-at-least-32-characters-long',
  jwtExpiresIn: '1h',
  locationMaxAgeMinutes: 15,
  autoAssignRadiusKm: 25,
};

function setupTestApp() {
  const ctx = { app: null };
  beforeAll(() => {
    db.initPool(process.env.DATABASE_URL);
    ctx.app = createApp(config);
  });
  beforeEach(async () => {
    // RESTART IDENTITY resets the id sequences; CASCADE follows the foreign keys
    await db.query(
      'TRUNCATE users, location_history, deliveries, vehicles, drivers, customers RESTART IDENTITY CASCADE',
    );
  });
  afterAll(() => db.closePool());
  return ctx;
}

/** Thin wrapper around supertest that adds the bearer token. */
function client(app, token) {
  const withAuth = r => (token ? r.set('Authorization', `Bearer ${token}`) : r);
  return {
    get: url => withAuth(request(app).get(url)),
    post: (url, body) => withAuth(request(app).post(url)).send(body ?? {}),
    patch: (url, body) => withAuth(request(app).patch(url)).send(body),
    delete: url => withAuth(request(app).delete(url)),
  };
}

async function adminToken(app) {
  await request(app).post('/api/auth/register').send({ username: 'admin', password: 'admin-password', role: 'ADMIN' });
  const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin-password' });
  return res.body.token;
}

async function dispatcherToken(app, adminTok) {
  await client(app, adminTok).post('/api/auth/register', { username: 'dispatcher', password: 'dispatcher-password' });
  const res = await request(app).post('/api/auth/login').send({ username: 'dispatcher', password: 'dispatcher-password' });
  return res.body.token;
}

let counter = 0;

/** An AVAILABLE vehicle with an ACTIVE driver, at the given position. Returns the vehicle id. */
async function readyVehicle(api, lat, lng, reg) {
  counter += 1; // unique phone/licence per call, whether or not a registration is passed
  reg = reg ?? `MH12T${counter}`;
  const vehicle = await api.post('/api/vehicles', { registrationNumber: reg, type: 'VAN' });
  const driver = await api.post('/api/drivers', {
    name: `Driver ${reg}`, phone: `90000${String(counter).padStart(5, '0')}`, licenseNumber: `LIC-${reg}`,
  });
  await api.patch(`/api/drivers/${driver.body.id}/assign-vehicle/${vehicle.body.id}`);
  await api.patch(`/api/vehicles/${vehicle.body.id}/location`, { latitude: lat, longitude: lng });
  return vehicle.body.id;
}

async function newDelivery(api, lat, lng) {
  const customer = await api.post('/api/customers', {
    name: 'Asha', phone: '9000000000',
    pickupLatitude: lat, pickupLongitude: lng, dropLatitude: lat + 0.05, dropLongitude: lng + 0.05,
  });
  const delivery = await api.post('/api/deliveries', { customerId: customer.body.id });
  return delivery.body.id;
}

module.exports = { setupTestApp, client, adminToken, dispatcherToken, readyVehicle, newDelivery, config };
