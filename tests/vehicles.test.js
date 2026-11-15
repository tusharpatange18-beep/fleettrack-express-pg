const db = require('../src/db/pool');
const { setupTestApp, client, adminToken, readyVehicle } = require('./helpers');

const ctx = setupTestApp();
let api;
beforeEach(async () => {
  api = client(ctx.app, await adminToken(ctx.app));
});

describe('vehicle CRUD and validation', () => {
  test('create defaults to AVAILABLE and accepts any letter case for enums', async () => {
    const res = await api.post('/api/vehicles', { registrationNumber: 'MH12AB1234', type: 'van' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 1, registrationNumber: 'MH12AB1234', type: 'VAN', status: 'AVAILABLE' });
  });

  test('invalid input is 400 and names the field', async () => {
    const res = await api.post('/api/vehicles', { registrationNumber: 'MH01', type: 'SPACESHIP' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^type:/);
    expect((await api.post('/api/vehicles', { type: 'VAN' })).status).toBe(400);
  });

  test('malformed JSON is 400', async () => {
    const res = await api.post('/api/vehicles').set('Content-Type', 'application/json').send('{not json');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Malformed JSON body');
  });

  test('duplicate registration number is 409 (UNIQUE constraint)', async () => {
    await api.post('/api/vehicles', { registrationNumber: 'MH12AB1234', type: 'VAN' });
    const res = await api.post('/api/vehicles', { registrationNumber: 'MH12AB1234', type: 'BIKE' });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('A vehicle with this registration number already exists');
  });

  test('PATCH changes only the fields sent; users cannot set BUSY', async () => {
    const { body } = await api.post('/api/vehicles', { registrationNumber: 'MH12AB1234', type: 'VAN' });
    const res = await api.patch(`/api/vehicles/${body.id}`, { type: 'TRUCK' });
    expect(res.body).toMatchObject({ type: 'TRUCK', registrationNumber: 'MH12AB1234', status: 'AVAILABLE' });
    expect((await api.patch(`/api/vehicles/${body.id}`, { status: 'BUSY' })).status).toBe(400);
  });

  test('unknown id is 404, non-numeric id is 400', async () => {
    expect((await api.get('/api/vehicles/999')).status).toBe(404);
    expect((await api.get('/api/vehicles/abc')).status).toBe(400);
  });

  test('list is paginated', async () => {
    for (const reg of ['A1', 'A2', 'A3']) await api.post('/api/vehicles', { registrationNumber: reg, type: 'BIKE' });
    const res = await api.get('/api/vehicles?size=2&page=1');
    expect(res.body).toMatchObject({ page: 1, size: 2, totalElements: 3, totalPages: 2 });
    expect(res.body.content.map(v => v.registrationNumber)).toEqual(['A3']);
  });

  test('DELETE is a soft delete that releases the driver', async () => {
    const id = await readyVehicle(api, 18.52, 73.85);
    expect((await api.delete(`/api/vehicles/${id}`)).status).toBe(204);
    const res = await api.get(`/api/vehicles/${id}`);
    expect(res.body).toMatchObject({ status: 'INACTIVE', driverId: null });
  });
});

describe('location tracking', () => {
  test('each update moves the vehicle and appends to history (newest first)', async () => {
    const { body } = await api.post('/api/vehicles', { registrationNumber: 'MH12AB1234', type: 'VAN' });
    for (const lat of [18.50, 18.51, 18.52]) {
      await api.patch(`/api/vehicles/${body.id}/location`, { latitude: lat, longitude: 73.85 });
    }
    expect((await api.get(`/api/vehicles/${body.id}`)).body.currentLatitude).toBe(18.52);
    const history = await api.get(`/api/vehicles/${body.id}/locations`);
    expect(history.body.totalElements).toBe(3);
    expect(history.body.content.map(p => p.latitude)).toEqual([18.52, 18.51, 18.50]);
  });

  test('out-of-range coordinates are 400; deactivated vehicles are 409', async () => {
    const { body } = await api.post('/api/vehicles', { registrationNumber: 'MH12AB1234', type: 'VAN' });
    expect((await api.patch(`/api/vehicles/${body.id}/location`, { latitude: 91, longitude: 0 })).status).toBe(400);
    await api.delete(`/api/vehicles/${body.id}`);
    expect((await api.patch(`/api/vehicles/${body.id}/location`, { latitude: 18, longitude: 73 })).status).toBe(409);
  });
});

describe('nearby search (Haversine in SQL)', () => {
  const PUNE = { lat: 18.5204, lng: 73.8567 };

  test('returns AVAILABLE vehicles within the radius, nearest first, with distance', async () => {
    const near = await readyVehicle(api, PUNE.lat, PUNE.lng);
    const twoKm = await readyVehicle(api, PUNE.lat + 0.018, PUNE.lng); // ~2 km north
    await readyVehicle(api, 19.0760, 72.8777); // Mumbai, ~120 km away

    const res = await api.get(`/api/vehicles/nearby?latitude=${PUNE.lat}&longitude=${PUNE.lng}&radiusKm=10`);
    expect(res.body.map(v => v.vehicleId)).toEqual([near, twoKm]);
    expect(res.body[0].distanceKm).toBe(0);
    expect(res.body[1].distanceKm).toBeCloseTo(2.0, 1);
  });

  test('skips BUSY/OFFLINE vehicles and vehicles with a stale location', async () => {
    const offline = await readyVehicle(api, PUNE.lat, PUNE.lng);
    await api.patch(`/api/vehicles/${offline}`, { status: 'OFFLINE' });
    const stale = await readyVehicle(api, PUNE.lat, PUNE.lng);
    await db.query("UPDATE vehicles SET location_updated_at = now() - interval '2 hours' WHERE id = $1", [stale]);

    const res = await api.get(`/api/vehicles/nearby?latitude=${PUNE.lat}&longitude=${PUNE.lng}&radiusKm=10`);
    expect(res.body).toEqual([]);
  });

  test('radius is validated', async () => {
    expect((await api.get('/api/vehicles/nearby?latitude=18&longitude=73&radiusKm=0')).status).toBe(400);
    expect((await api.get('/api/vehicles/nearby?latitude=100&longitude=73')).status).toBe(400);
  });

  test('haversine_km matches a known distance (Mumbai to Pune is about 120 km)', async () => {
    const { rows } = await db.query('SELECT haversine_km(19.0760, 72.8777, 18.5204, 73.8567) AS km');
    expect(rows[0].km).toBeGreaterThan(115);
    expect(rows[0].km).toBeLessThan(125);
  });
});
