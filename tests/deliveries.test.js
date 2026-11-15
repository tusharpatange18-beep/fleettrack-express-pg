const db = require('../src/db/pool');
const { isValidTransition, TRANSITIONS } = require('../src/services/deliveryService');
const { setupTestApp, client, adminToken, readyVehicle, newDelivery } = require('./helpers');

const ctx = setupTestApp();
const LAT = 18.5204;
const LNG = 73.8567;
let api;
beforeEach(async () => {
  api = client(ctx.app, await adminToken(ctx.app));
});

describe('state machine table', () => {
  const statuses = Object.keys(TRANSITIONS);
  const allowed = new Set([
    'CREATED>ASSIGNED', 'CREATED>CANCELLED', 'ASSIGNED>PICKED_UP', 'ASSIGNED>CANCELLED',
    'PICKED_UP>IN_TRANSIT', 'IN_TRANSIT>DELIVERED',
  ]);
  // All 36 (from, to) pairs
  test.each(statuses.flatMap(from => statuses.map(to => [from, to])))('%s -> %s', (from, to) => {
    expect(isValidTransition(from, to)).toBe(allowed.has(`${from}>${to}`));
  });
});

describe('delivery lifecycle over HTTP', () => {
  test('route defaults to the customer and can be overridden', async () => {
    const customer = await api.post('/api/customers', {
      name: 'Asha', phone: '9000000000', pickupLatitude: LAT, pickupLongitude: LNG, dropLatitude: 18.6, dropLongitude: 73.8,
    });
    const plain = await api.post('/api/deliveries', { customerId: customer.body.id });
    expect(plain.body).toMatchObject({ status: 'CREATED', pickupLatitude: LAT, dropLatitude: 18.6 });

    const custom = await api.post('/api/deliveries', { customerId: customer.body.id, pickupLatitude: 18.7, pickupLongitude: 73.9 });
    expect(custom.body).toMatchObject({ pickupLatitude: 18.7, dropLatitude: 18.6 });

    const half = await api.post('/api/deliveries', { customerId: customer.body.id, pickupLatitude: 18.7 });
    expect(half.status).toBe(400);
    expect((await api.post('/api/deliveries', { customerId: 999 })).status).toBe(404);
  });

  test('full lifecycle releases the vehicle at the end', async () => {
    const vehicleId = await readyVehicle(api, LAT, LNG);
    const deliveryId = await newDelivery(api, LAT, LNG);

    const assigned = await api.patch(`/api/deliveries/${deliveryId}/assign?vehicleId=${vehicleId}`);
    expect(assigned.body).toMatchObject({ status: 'ASSIGNED', vehicleId });
    expect((await api.get(`/api/vehicles/${vehicleId}`)).body.status).toBe('BUSY');

    for (const status of ['PICKED_UP', 'IN_TRANSIT', 'DELIVERED']) {
      const res = await api.patch(`/api/deliveries/${deliveryId}/status`, { status });
      expect(res.body.status).toBe(status);
    }
    const done = await api.get(`/api/deliveries/${deliveryId}`);
    expect(done.body.deliveredAt).not.toBeNull();
    expect((await api.get(`/api/vehicles/${vehicleId}`)).body.status).toBe('AVAILABLE');
  });

  test('invalid jumps are 409, ASSIGNED via the status endpoint is 400', async () => {
    const deliveryId = await newDelivery(api, LAT, LNG);
    expect((await api.patch(`/api/deliveries/${deliveryId}/status`, { status: 'DELIVERED' })).status).toBe(409);
    expect((await api.patch(`/api/deliveries/${deliveryId}/status`, { status: 'ASSIGNED' })).status).toBe(400);
  });

  test('cancelling an assigned delivery frees the vehicle', async () => {
    const vehicleId = await readyVehicle(api, LAT, LNG);
    const deliveryId = await newDelivery(api, LAT, LNG);
    await api.patch(`/api/deliveries/${deliveryId}/assign?vehicleId=${vehicleId}`);
    await api.patch(`/api/deliveries/${deliveryId}/status`, { status: 'CANCELLED' });
    expect((await api.get(`/api/vehicles/${vehicleId}`)).body.status).toBe('AVAILABLE');
  });
});

describe('assignment rules', () => {
  test('vehicle without a driver -> 409', async () => {
    const { body: vehicle } = await api.post('/api/vehicles', { registrationNumber: 'NODRIVER', type: 'VAN' });
    const deliveryId = await newDelivery(api, LAT, LNG);
    const res = await api.patch(`/api/deliveries/${deliveryId}/assign?vehicleId=${vehicle.id}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Vehicle does not have an assigned driver');
  });

  test('BUSY or OFFLINE vehicle -> 409', async () => {
    const vehicleId = await readyVehicle(api, LAT, LNG);
    const first = await newDelivery(api, LAT, LNG);
    const second = await newDelivery(api, LAT, LNG);
    await api.patch(`/api/deliveries/${first}/assign?vehicleId=${vehicleId}`);
    expect((await api.patch(`/api/deliveries/${second}/assign?vehicleId=${vehicleId}`)).status).toBe(409);

    const offline = await readyVehicle(api, LAT, LNG);
    await api.patch(`/api/vehicles/${offline}`, { status: 'OFFLINE' });
    expect((await api.patch(`/api/deliveries/${second}/assign?vehicleId=${offline}`)).status).toBe(409);
  });

  test('inactive driver -> 409 (deactivating also unlinks the driver)', async () => {
    const vehicleId = await readyVehicle(api, LAT, LNG);
    const driverId = (await api.get(`/api/vehicles/${vehicleId}`)).body.driverId;
    await db.query("UPDATE drivers SET status = 'INACTIVE' WHERE id = $1", [driverId]); // bypass the API on purpose
    const deliveryId = await newDelivery(api, LAT, LNG);
    const res = await api.patch(`/api/deliveries/${deliveryId}/assign?vehicleId=${vehicleId}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe("The vehicle's driver is not ACTIVE");
  });

  test('a vehicle on a job cannot be deleted, set OFFLINE or lose its driver', async () => {
    const vehicleId = await readyVehicle(api, LAT, LNG);
    const driverId = (await api.get(`/api/vehicles/${vehicleId}`)).body.driverId;
    const deliveryId = await newDelivery(api, LAT, LNG);
    await api.patch(`/api/deliveries/${deliveryId}/assign?vehicleId=${vehicleId}`);

    expect((await api.delete(`/api/vehicles/${vehicleId}`)).status).toBe(409);
    expect((await api.patch(`/api/vehicles/${vehicleId}`, { status: 'OFFLINE' })).status).toBe(409);
    expect((await api.delete(`/api/drivers/${driverId}/vehicle`)).status).toBe(409);
    expect((await api.delete(`/api/drivers/${driverId}`)).status).toBe(409);
  });

  test('a failed assignment changes nothing (transaction rolled back)', async () => {
    const { body: vehicle } = await api.post('/api/vehicles', { registrationNumber: 'NODRIVER', type: 'VAN' });
    const deliveryId = await newDelivery(api, LAT, LNG);
    await api.patch(`/api/deliveries/${deliveryId}/assign?vehicleId=${vehicle.id}`);
    expect((await api.get(`/api/deliveries/${deliveryId}`)).body.status).toBe('CREATED');
    expect((await api.get(`/api/vehicles/${vehicle.id}`)).body.status).toBe('AVAILABLE');
  });
});

describe('auto-assign', () => {
  test('picks the nearest vehicle that can take the job', async () => {
    const far = await readyVehicle(api, LAT + 0.09, LNG);   // ~10 km
    const near = await readyVehicle(api, LAT + 0.02, LNG);  // ~2.2 km
    const { body: noDriver } = await api.post('/api/vehicles', { registrationNumber: 'NODRIVER', type: 'VAN' });
    await api.patch(`/api/vehicles/${noDriver.id}/location`, { latitude: LAT, longitude: LNG }); // closest, but no driver

    const first = await newDelivery(api, LAT, LNG);
    const res = await api.post(`/api/deliveries/${first}/auto-assign`);
    expect(res.status).toBe(200);
    expect(res.body.delivery.vehicleId).toBe(near);
    expect(res.body.distanceKm).toBeCloseTo(2.22, 1);

    const second = await newDelivery(api, LAT, LNG);
    expect((await api.post(`/api/deliveries/${second}/auto-assign`)).body.delivery.vehicleId).toBe(far);
  });

  test('nobody in range -> 409 and the delivery stays CREATED', async () => {
    await readyVehicle(api, 28.7041, 77.1025); // Delhi
    const deliveryId = await newDelivery(api, LAT, LNG);
    expect((await api.post(`/api/deliveries/${deliveryId}/auto-assign?radiusKm=50`)).status).toBe(409);
    expect((await api.get(`/api/deliveries/${deliveryId}`)).body.status).toBe('CREATED');
  });
});
