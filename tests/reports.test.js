const db = require('../src/db/pool');
const { setupTestApp, client, adminToken, readyVehicle, newDelivery } = require('./helpers');

const ctx = setupTestApp();
const LAT = 18.5204;
const LNG = 73.8567;
let api;
beforeEach(async () => {
  api = client(ctx.app, await adminToken(ctx.app));
});

async function completeDelivery(vehicleId) {
  const id = await newDelivery(api, LAT, LNG);
  await api.patch(`/api/deliveries/${id}/assign?vehicleId=${vehicleId}`);
  for (const status of ['PICKED_UP', 'IN_TRANSIT', 'DELIVERED']) {
    await api.patch(`/api/deliveries/${id}/status`, { status });
  }
  return id;
}

test('deliveries per driver: counts recent completions and includes drivers with none', async () => {
  const busy = await readyVehicle(api, LAT, LNG, 'BUSY1');
  await readyVehicle(api, LAT, LNG, 'IDLE1');
  await completeDelivery(busy);
  await completeDelivery(busy);
  const old = await completeDelivery(busy);
  // Pretend one finished 10 days ago: outside the 7-day window
  await db.query("UPDATE deliveries SET delivered_at = now() - interval '10 days' WHERE id = $1", [old]);

  const res = await api.get('/api/reports/deliveries-per-driver?days=7');
  expect(res.status).toBe(200);
  expect(res.body).toEqual([
    { driverId: 1, driverName: 'Driver BUSY1', completed: 2 },
    { driverId: 2, driverName: 'Driver IDLE1', completed: 0 },
  ]);
  expect((await api.get('/api/reports/deliveries-per-driver?days=30')).body[0].completed).toBe(3);
});

test('vehicles by status, with how many have an active driver', async () => {
  await readyVehicle(api, LAT, LNG);
  await readyVehicle(api, LAT, LNG);
  await api.post('/api/vehicles', { registrationNumber: 'NODRIVER', type: 'BIKE' });
  const offline = await api.post('/api/vehicles', { registrationNumber: 'OFF1', type: 'BIKE', status: 'OFFLINE' });
  expect(offline.status).toBe(201);

  const res = await api.get('/api/reports/vehicles-by-status');
  expect(res.body).toEqual([
    { status: 'AVAILABLE', vehicles: 3, withActiveDriver: 2 },
    { status: 'OFFLINE', vehicles: 1, withActiveDriver: 0 },
  ]);
});

test('dashboard summary lists every status, including zeros', async () => {
  const vehicleId = await readyVehicle(api, LAT, LNG);
  const id = await newDelivery(api, LAT, LNG);
  await api.patch(`/api/deliveries/${id}/assign?vehicleId=${vehicleId}`);

  const res = await api.get('/api/dashboard/summary');
  expect(res.body).toEqual({
    vehiclesByStatus: { AVAILABLE: 0, BUSY: 1, OFFLINE: 0, INACTIVE: 0 },
    deliveriesByStatus: { CREATED: 0, ASSIGNED: 1, PICKED_UP: 0, IN_TRANSIT: 0, DELIVERED: 0, CANCELLED: 0 },
    activeDeliveries: 1,
    activeDrivers: 1,
  });
});
