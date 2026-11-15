// Proves the transaction + row-lock design under real concurrency (parallel requests,
// separate pool connections, real PostgreSQL).
const db = require('../src/db/pool');
const { setupTestApp, client, adminToken, readyVehicle, newDelivery } = require('./helpers');

const ctx = setupTestApp();
const LAT = 18.5204;
const LNG = 73.8567;
let api;
beforeEach(async () => {
  api = client(ctx.app, await adminToken(ctx.app));
});

test('8 dispatchers assigning the same vehicle at once: exactly one wins', async () => {
  const vehicleId = await readyVehicle(api, LAT, LNG);
  const deliveryIds = [];
  for (let i = 0; i < 8; i++) deliveryIds.push(await newDelivery(api, LAT, LNG));

  const results = await Promise.all(
    deliveryIds.map(id => api.patch(`/api/deliveries/${id}/assign?vehicleId=${vehicleId}`)),
  );
  const statuses = results.map(r => r.status).sort();
  expect(statuses.filter(s => s === 200)).toHaveLength(1);
  expect(statuses.filter(s => s === 409)).toHaveLength(7);

  const { rows } = await db.query("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'ASSIGNED'");
  expect(rows[0].n).toBe(1);
});

test('parallel auto-assigns spread over different vehicles (SKIP LOCKED)', async () => {
  for (let i = 0; i < 4; i++) await readyVehicle(api, LAT + i * 0.001, LNG);
  const deliveryIds = [];
  for (let i = 0; i < 4; i++) deliveryIds.push(await newDelivery(api, LAT, LNG));

  const results = await Promise.all(deliveryIds.map(id => api.post(`/api/deliveries/${id}/auto-assign`)));
  expect(results.map(r => r.status)).toEqual([200, 200, 200, 200]);
  const vehicles = new Set(results.map(r => r.body.delivery.vehicleId));
  expect(vehicles.size).toBe(4);
});

test('the partial unique index blocks two active deliveries on one vehicle, even in raw SQL', async () => {
  const vehicleId = await readyVehicle(api, LAT, LNG);
  const driverId = (await api.get(`/api/vehicles/${vehicleId}`)).body.driverId;
  const a = await newDelivery(api, LAT, LNG);
  const b = await newDelivery(api, LAT, LNG);
  const assign = id => db.query(
    "UPDATE deliveries SET status = 'ASSIGNED', vehicle_id = $2, driver_id = $3 WHERE id = $1", [id, vehicleId, driverId],
  );
  await assign(a);
  await expect(assign(b)).rejects.toMatchObject({ code: '23505', constraint: 'uq_deliveries_one_active_per_vehicle' });
});

test('a location ping does not overwrite a concurrent status change', async () => {
  const vehicleId = await readyVehicle(api, LAT, LNG);
  const deliveryId = await newDelivery(api, LAT, LNG);
  // Fire the assignment and several pings together
  await Promise.all([
    api.patch(`/api/deliveries/${deliveryId}/assign?vehicleId=${vehicleId}`),
    ...[1, 2, 3, 4, 5].map(i => api.patch(`/api/vehicles/${vehicleId}/location`, { latitude: LAT + i / 1000, longitude: LNG })),
  ]);
  expect((await api.get(`/api/vehicles/${vehicleId}`)).body.status).toBe('BUSY');
});
