const db = require('../db/pool');
const { notFound, conflict, badRequest } = require('../errors');
const { orderBy, toPage, roundTo2 } = require('./pagination');
const { lockVehicle } = require('./vehicleService');

/**
 * The delivery state machine: for each status, the statuses it may move to.
 * CREATED -> ASSIGNED happens only through assign()/autoAssign(), because it needs a vehicle.
 */
const TRANSITIONS = {
  CREATED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: ['IN_TRANSIT'],
  IN_TRANSIT: ['DELIVERED'],
  DELIVERED: [],   // finished: no moves
  CANCELLED: [],   // finished: no moves
};

/** True if the state machine allows moving from one status to the other. */
function isValidTransition(from, to) {
  const allowedNext = TRANSITIONS[from];
  if (!allowedNext) {
    return false; // unknown status: nothing is allowed
  }
  return allowedNext.includes(to);
}

/** DELIVERED and CANCELLED are final: the delivery can never change again. */
function isTerminal(status) {
  return status === 'DELIVERED' || status === 'CANCELLED';
}

/** Database row (snake_case) -> API JSON (camelCase). */
function mapDelivery(r) {
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    driverId: r.driver_id,
    customerId: r.customer_id,
    status: r.status,
    pickupLatitude: r.pickup_latitude,
    pickupLongitude: r.pickup_longitude,
    dropLatitude: r.drop_latitude,
    dropLongitude: r.drop_longitude,
    assignedAt: r.assigned_at,
    deliveredAt: r.delivered_at,
  };
}

/** A value that was not sent (undefined) becomes NULL for SQL. */
function orNull(value) {
  if (value === undefined) {
    return null;
  }
  return value;
}

/** One page of deliveries. */
async function list(paging) {
  // $1 = how many rows, $2 = how many rows to skip (page 2 with size 20 skips 40)
  const { rows } = await db.query(
    `SELECT * FROM deliveries ${orderBy(paging.sort)} LIMIT $1 OFFSET $2`,
    [paging.size, paging.page * paging.size],
  );
  const count = await db.query('SELECT COUNT(*) AS total FROM deliveries');
  return toPage(rows, count.rows[0].total, paging, mapDelivery);
}

async function get(id) {
  const { rows } = await db.query('SELECT * FROM deliveries WHERE id = $1', [id]);
  if (rows.length === 0) {
    throw notFound(`Delivery not found with id: ${id}`);
  }
  return mapDelivery(rows[0]);
}

/** Creates a CREATED delivery. Any route pair not sent is copied from the customer. */
async function create(request) {
  // One statement: INSERT ... SELECT reads the customer and writes the delivery together.
  // COALESCE picks the request value when given, else the customer's saved address.
  const { rows } = await db.query(
    `INSERT INTO deliveries (customer_id, pickup_latitude, pickup_longitude, drop_latitude, drop_longitude)
     SELECT c.id,
            COALESCE($2, c.pickup_latitude), COALESCE($3, c.pickup_longitude),
            COALESCE($4, c.drop_latitude),   COALESCE($5, c.drop_longitude)
       FROM customers c
      WHERE c.id = $1
     RETURNING *`,
    [
      request.customerId,
      orNull(request.pickupLatitude),
      orNull(request.pickupLongitude),
      orNull(request.dropLatitude),
      orNull(request.dropLongitude),
    ],
  );
  // No row inserted means the SELECT found no customer
  if (rows.length === 0) {
    throw notFound(`Customer not found with id: ${request.customerId}`);
  }
  return mapDelivery(rows[0]);
}

/** SELECT ... FOR UPDATE: no other transaction can change this delivery until we finish. */
async function lockDelivery(client, id) {
  const { rows } = await client.query('SELECT * FROM deliveries WHERE id = $1 FOR UPDATE', [id]);
  if (rows.length === 0) {
    throw notFound(`Delivery not found with id: ${id}`);
  }
  return rows[0];
}

/**
 * The assignment itself. The caller must hold row locks on both the delivery and the vehicle,
 * so nothing can change between these checks and the UPDATEs.
 */
async function applyAssignment(client, delivery, vehicle) {
  // Check every rule; each failed rule answers 409 Conflict with a clear message
  if (delivery.status !== 'CREATED') {
    throw conflict(`Delivery must be in CREATED state to assign, current state: ${delivery.status}`);
  }
  if (vehicle.status !== 'AVAILABLE') {
    throw conflict(`Vehicle is not AVAILABLE (status: ${vehicle.status})`);
  }
  if (vehicle.driver_id === null) {
    throw conflict('Vehicle does not have an assigned driver');
  }

  const driverResult = await client.query('SELECT status FROM drivers WHERE id = $1', [vehicle.driver_id]);
  if (driverResult.rows[0].status !== 'ACTIVE') {
    throw conflict("The vehicle's driver is not ACTIVE");
  }

  // All rules passed: the delivery gets the vehicle and its driver, the vehicle becomes BUSY
  const { rows } = await client.query(
    `UPDATE deliveries
        SET status = 'ASSIGNED', vehicle_id = $2, driver_id = $3, assigned_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [delivery.id, vehicle.id, vehicle.driver_id],
  );
  await client.query("UPDATE vehicles SET status = 'BUSY', updated_at = now() WHERE id = $1", [vehicle.id]);
  return rows[0];
}

/**
 * Manual assignment, in one transaction:
 *   1. lock the delivery row, 2. lock the vehicle row, 3. check the rules, 4. update both.
 * Two dispatchers assigning the same vehicle: the second one blocks at step 2 until the first
 * commits, then reads status = BUSY and gets 409. Locks are always taken delivery-first,
 * vehicle-second, so two transactions can never wait on each other in a cycle (deadlock).
 */
async function assign(deliveryId, vehicleId) {
  return db.withTransaction(async function (client) {
    const delivery = await lockDelivery(client, deliveryId);
    const vehicle = await lockVehicle(client, vehicleId);
    const updated = await applyAssignment(client, delivery, vehicle);
    return mapDelivery(updated);
  });
}

/**
 * Assigns the nearest vehicle that can take the job: AVAILABLE, with an ACTIVE driver, a fresh
 * location, within radiusKm of the pickup.
 *
 * FOR UPDATE OF v SKIP LOCKED: lock the chosen vehicle row; if another transaction already holds
 * a lock on a candidate (it is being assigned right now), skip it and take the next nearest
 * instead of waiting. So parallel auto-assigns spread over different vehicles. The status filter
 * is re-checked on the locked row, so a vehicle that just became BUSY is never returned.
 */
async function autoAssign(deliveryId, radiusKm, config) {
  return db.withTransaction(async function (client) {
    const delivery = await lockDelivery(client, deliveryId);
    if (delivery.status !== 'CREATED') {
      throw conflict(`Delivery must be in CREATED state to assign, current state: ${delivery.status}`);
    }

    // $1/$2 = pickup point, $3 = radius in km, $4 = max location age in minutes.
    // 111.045 km = one degree of latitude, so the BETWEEN band holds every point within the radius.
    const { rows } = await client.query(
      `SELECT v.*, haversine_km($1::float8, $2::float8, v.current_latitude, v.current_longitude) AS distance_km
         FROM vehicles v
         JOIN drivers d ON d.id = v.driver_id
        WHERE v.status = 'AVAILABLE'
          AND d.status = 'ACTIVE'
          AND v.current_latitude BETWEEN $1::float8 - $3::float8 / 111.045
                                     AND $1::float8 + $3::float8 / 111.045
          AND v.location_updated_at >= now() - make_interval(mins => $4::int)
          AND haversine_km($1::float8, $2::float8, v.current_latitude, v.current_longitude) <= $3::float8
        ORDER BY distance_km, v.id
        LIMIT 1
        FOR UPDATE OF v SKIP LOCKED`,
      [delivery.pickup_latitude, delivery.pickup_longitude, radiusKm, config.locationMaxAgeMinutes],
    );
    if (rows.length === 0) {
      throw conflict(`No available vehicle with an active driver within ${radiusKm} km of the pickup`);
    }

    const nearest = rows[0];
    const assigned = await applyAssignment(client, delivery, nearest);
    return { delivery: mapDelivery(assigned), distanceKm: roundTo2(nearest.distance_km) };
  });
}

/** Moves a delivery along the state machine; frees the vehicle when it finishes. */
async function updateStatus(id, newStatus) {
  // ASSIGNED needs a vehicle, so it has its own endpoint
  if (newStatus === 'ASSIGNED') {
    throw badRequest('Use PATCH /api/deliveries/{id}/assign to assign a vehicle');
  }

  return db.withTransaction(async function (client) {
    const delivery = await lockDelivery(client, id);
    if (!isValidTransition(delivery.status, newStatus)) {
      throw conflict(`Invalid state transition from ${delivery.status} to ${newStatus}`);
    }

    // $2 is used twice; the ::text casts give it one unambiguous type (without them Postgres
    // deduces VARCHAR from the column and TEXT from the comparison, and rejects the query)
    const { rows } = await client.query(
      `UPDATE deliveries
          SET status = $2::text,
              delivered_at = CASE WHEN $2::text = 'DELIVERED' THEN now() ELSE delivered_at END,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, newStatus],
    );

    // A finished delivery gives its vehicle back
    if (isTerminal(newStatus) && delivery.vehicle_id !== null) {
      // Only a BUSY vehicle goes back to AVAILABLE (an INACTIVE one stays INACTIVE)
      await client.query(
        "UPDATE vehicles SET status = 'AVAILABLE', updated_at = now() WHERE id = $1 AND status = 'BUSY'",
        [delivery.vehicle_id],
      );
    }
    return mapDelivery(rows[0]);
  });
}

module.exports = { list, get, create, assign, autoAssign, updateStatus, isValidTransition, TRANSITIONS };
