const db = require('../db/pool');
const { notFound, conflict, badRequest } = require('../errors');
const { orderBy, toPage } = require('./pagination');

const ACTIVE_DELIVERY = "('ASSIGNED', 'PICKED_UP', 'IN_TRANSIT')";

// snake_case row from Postgres -> camelCase JSON for the API
function mapVehicle(r) {
  return {
    id: r.id,
    registrationNumber: r.registration_number,
    type: r.type,
    status: r.status,
    currentLatitude: r.current_latitude,
    currentLongitude: r.current_longitude,
    locationUpdatedAt: r.location_updated_at,
    driverId: r.driver_id,
  };
}

async function list(paging) {
  const { rows } = await db.query(
    `SELECT * FROM vehicles ${orderBy(paging.sort)} LIMIT $1 OFFSET $2`,
    [paging.size, paging.page * paging.size],
  );
  const count = await db.query('SELECT COUNT(*) AS total FROM vehicles');
  return toPage(rows, count.rows[0].total, paging, mapVehicle);
}

async function get(id) {
  const { rows } = await db.query('SELECT * FROM vehicles WHERE id = $1', [id]);
  if (rows.length === 0) throw notFound(`Vehicle not found with id: ${id}`);
  return mapVehicle(rows[0]);
}

async function create({ registrationNumber, type, status = 'AVAILABLE' }) {
  // A duplicate registration number hits the UNIQUE constraint -> 23505 -> 409 in the error handler
  const { rows } = await db.query(
    'INSERT INTO vehicles (registration_number, type, status) VALUES ($1, $2, $3) RETURNING *',
    [registrationNumber, type, status],
  );
  return mapVehicle(rows[0]);
}

/**
 * Locks the vehicle row until the transaction ends (SELECT ... FOR UPDATE). Any other transaction
 * that tries to lock or update the same row waits, so check-then-act logic cannot interleave.
 */
async function lockVehicle(client, id) {
  const { rows } = await client.query('SELECT * FROM vehicles WHERE id = $1 FOR UPDATE', [id]);
  if (rows.length === 0) throw notFound(`Vehicle not found with id: ${id}`);
  return rows[0];
}

/** The deliveries table is the source of truth for "is this vehicle on a job?" */
async function hasActiveDelivery(client, vehicleId) {
  const { rowCount } = await client.query(
    `SELECT 1 FROM deliveries WHERE vehicle_id = $1 AND status IN ${ACTIVE_DELIVERY} LIMIT 1`,
    [vehicleId],
  );
  return rowCount > 0;
}

/** Partial update: only fields present in `changes` are written. */
async function update(id, changes) {
  return db.withTransaction(async client => {
    const vehicle = await lockVehicle(client, id);
    if (changes.status && changes.status !== vehicle.status && (await hasActiveDelivery(client, id))) {
      throw conflict('Vehicle is on an active delivery; finish or cancel it first');
    }
    // COALESCE($n, column) keeps the old value when the parameter is NULL (field not sent)
    const { rows } = await client.query(
      `UPDATE vehicles
          SET registration_number = COALESCE($2, registration_number),
              type                = COALESCE($3, type),
              status              = COALESCE($4, status),
              updated_at          = now()
        WHERE id = $1
        RETURNING *`,
      [id, changes.registrationNumber ?? null, changes.type ?? null, changes.status ?? null],
    );
    return mapVehicle(rows[0]);
  });
}

/** Soft delete: INACTIVE and driver released; history and past deliveries stay intact. */
async function remove(id) {
  await db.withTransaction(async client => {
    await lockVehicle(client, id);
    if (await hasActiveDelivery(client, id)) {
      throw conflict('Vehicle is on an active delivery; finish or cancel it first');
    }
    await client.query(
      "UPDATE vehicles SET status = 'INACTIVE', driver_id = NULL, updated_at = now() WHERE id = $1",
      [id],
    );
  });
}

/**
 * Moves the vehicle and appends to its location history, atomically.
 * The UPDATE writes only the three location columns, so it cannot overwrite a status change made
 * by a concurrent assignment (the "lost update" problem an ORM that rewrites whole rows can have).
 */
async function updateLocation(id, { latitude, longitude }) {
  return db.withTransaction(async client => {
    const { rows } = await client.query(
      `UPDATE vehicles
          SET current_latitude = $2, current_longitude = $3, location_updated_at = now()
        WHERE id = $1 AND status <> 'INACTIVE'
        RETURNING *`,
      [id, latitude, longitude],
    );
    if (rows.length === 0) {
      await get(id); // throws 404 if the vehicle does not exist at all
      throw conflict('Vehicle is deactivated');
    }
    await client.query(
      'INSERT INTO location_history (vehicle_id, latitude, longitude, recorded_at) VALUES ($1, $2, $3, $4)',
      [id, latitude, longitude, rows[0].location_updated_at],
    );
    return mapVehicle(rows[0]);
  });
}

/** A vehicle's trail, newest first. Served by the index (vehicle_id, recorded_at DESC). */
async function locationHistory(id, { from, to, page, size }) {
  await get(id); // 404 for unknown vehicles instead of an empty list
  if (from && to && new Date(from) > new Date(to)) throw badRequest("'from' must not be after 'to'");
  // NULL parameters disable the corresponding bound
  const where = `vehicle_id = $1
                 AND ($2::timestamptz IS NULL OR recorded_at >= $2)
                 AND ($3::timestamptz IS NULL OR recorded_at <= $3)`;
  const params = [id, from ?? null, to ?? null];
  const { rows } = await db.query(
    `SELECT id, latitude, longitude, recorded_at FROM location_history
      WHERE ${where} ORDER BY recorded_at DESC, id DESC LIMIT $4 OFFSET $5`,
    [...params, size, page * size],
  );
  const count = await db.query(`SELECT COUNT(*) AS total FROM location_history WHERE ${where}`, params);
  return toPage(rows, count.rows[0].total, { page, size }, r => ({
    id: r.id, latitude: r.latitude, longitude: r.longitude, recordedAt: r.recorded_at,
  }));
}

/**
 * AVAILABLE vehicles with a fresh GPS ping within radiusKm of a point, nearest first.
 *
 *  - status = 'AVAILABLE' AND current_latitude BETWEEN ... : a cheap prefilter on the index
 *    (status, current_latitude). One degree of latitude is ~111.045 km everywhere, so this band
 *    contains every point within the radius. We do not prefilter longitude, because degrees of
 *    longitude shrink towards the poles and wrap at +-180 degrees.
 *  - location_updated_at >= now() - N minutes : skip vehicles whose position is out of date.
 *  - haversine_km(...) <= radius : the exact great-circle distance (migration 003).
 */
async function nearby({ latitude, longitude, radiusKm }, { locationMaxAgeMinutes }) {
  const { rows } = await db.query(
    `SELECT v.id, v.registration_number, v.type, v.driver_id, v.location_updated_at,
            haversine_km($1::float8, $2::float8, v.current_latitude, v.current_longitude) AS distance_km
       FROM vehicles v
      WHERE v.status = 'AVAILABLE'
        AND v.current_latitude BETWEEN $1::float8 - $3::float8 / 111.045
                                   AND $1::float8 + $3::float8 / 111.045
        AND v.location_updated_at >= now() - make_interval(mins => $4::int)
        AND haversine_km($1::float8, $2::float8, v.current_latitude, v.current_longitude) <= $3::float8
      ORDER BY distance_km, v.id`,
    [latitude, longitude, radiusKm, locationMaxAgeMinutes],
  );
  return rows.map(r => ({
    vehicleId: r.id,
    registrationNumber: r.registration_number,
    type: r.type,
    distanceKm: Math.round(r.distance_km * 100) / 100,
    driverId: r.driver_id,
    locationUpdatedAt: r.location_updated_at,
  }));
}

module.exports = {
  list, get, create, update, remove, updateLocation, locationHistory, nearby,
  lockVehicle, hasActiveDelivery, mapVehicle, ACTIVE_DELIVERY,
};
