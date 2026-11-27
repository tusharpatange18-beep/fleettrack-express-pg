const db = require('../db/pool');
const { notFound, conflict } = require('../errors');
const { orderBy, toPage } = require('./pagination');
const { lockVehicle, hasActiveDelivery } = require('./vehicleService');

/** Database row (snake_case) -> API JSON (camelCase). */
function mapDriver(r) {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    licenseNumber: r.license_number,
    status: r.status,
  };
}

/** A value that was not sent (undefined) becomes NULL for SQL. */
function orNull(value) {
  if (value === undefined) {
    return null;
  }
  return value;
}

/** One page of drivers. */
async function list(paging) {
  const { rows } = await db.query(
    `SELECT * FROM drivers ${orderBy(paging.sort)} LIMIT $1 OFFSET $2`,
    [paging.size, paging.page * paging.size],
  );
  const count = await db.query('SELECT COUNT(*) AS total FROM drivers');
  return toPage(rows, count.rows[0].total, paging, mapDriver);
}

async function get(id) {
  const { rows } = await db.query('SELECT * FROM drivers WHERE id = $1', [id]);
  if (rows.length === 0) {
    throw notFound(`Driver not found with id: ${id}`);
  }
  return mapDriver(rows[0]);
}

async function create(request) {
  // Duplicate phone or license -> UNIQUE constraint -> 409 with a specific message
  const { rows } = await db.query(
    'INSERT INTO drivers (name, phone, license_number, status) VALUES ($1, $2, $3, $4) RETURNING *',
    [request.name, request.phone, request.licenseNumber, request.status],
  );
  return mapDriver(rows[0]);
}

/**
 * If the driver's vehicle is not on a job, unlink them (used when deactivating a driver).
 * Locks the vehicle first so an assignment cannot start in between.
 */
async function releaseFromVehicle(client, driverId) {
  const { rows } = await client.query('SELECT id FROM vehicles WHERE driver_id = $1', [driverId]);
  if (rows.length === 0) {
    return; // the driver has no vehicle: nothing to do
  }
  const vehicle = await lockVehicle(client, rows[0].id);
  if (await hasActiveDelivery(client, vehicle.id)) {
    throw conflict("The driver's vehicle is on an active delivery; finish or cancel it first");
  }
  await client.query('UPDATE vehicles SET driver_id = NULL, updated_at = now() WHERE id = $1', [vehicle.id]);
}

/** Partial update: only fields present in `changes` are written. */
async function update(id, changes) {
  return db.withTransaction(async function (client) {
    // Lock the driver row while we work on it
    const found = await client.query('SELECT * FROM drivers WHERE id = $1 FOR UPDATE', [id]);
    if (found.rows.length === 0) {
      throw notFound(`Driver not found with id: ${id}`);
    }

    // A driver who is being made INACTIVE must give up their vehicle
    const becomingInactive = changes.status === 'INACTIVE' && found.rows[0].status !== 'INACTIVE';
    if (becomingInactive) {
      await releaseFromVehicle(client, id);
    }

    // COALESCE($n, column) keeps the old value when the parameter is NULL (field not sent)
    const { rows } = await client.query(
      `UPDATE drivers
          SET name           = COALESCE($2, name),
              phone          = COALESCE($3, phone),
              license_number = COALESCE($4, license_number),
              status         = COALESCE($5, status),
              updated_at     = now()
        WHERE id = $1
        RETURNING *`,
      [id, orNull(changes.name), orNull(changes.phone), orNull(changes.licenseNumber), orNull(changes.status)],
    );
    return mapDriver(rows[0]);
  });
}

/** Soft delete: INACTIVE and unlinked from their vehicle. */
async function remove(id) {
  await update(id, { status: 'INACTIVE' });
}

/**
 * Links a driver to a vehicle. Rules: driver ACTIVE; vehicle AVAILABLE and without a driver.
 * "Driver already on another vehicle" is enforced by UNIQUE(vehicles.driver_id).
 */
async function assignVehicle(driverId, vehicleId) {
  await db.withTransaction(async function (client) {
    // FOR SHARE: others may read the driver, but nobody may change them until we finish
    const { rows } = await client.query('SELECT status FROM drivers WHERE id = $1 FOR SHARE', [driverId]);
    if (rows.length === 0) {
      throw notFound(`Driver not found with id: ${driverId}`);
    }
    if (rows[0].status !== 'ACTIVE') {
      throw conflict('Driver is not active and cannot be assigned');
    }

    const vehicle = await lockVehicle(client, vehicleId);
    if (vehicle.status !== 'AVAILABLE') {
      throw conflict(`Vehicle is not AVAILABLE (status: ${vehicle.status})`);
    }
    if (vehicle.driver_id !== null) {
      throw conflict(`Vehicle already has a driver assigned (driver id: ${vehicle.driver_id})`);
    }
    await client.query('UPDATE vehicles SET driver_id = $2, updated_at = now() WHERE id = $1', [vehicleId, driverId]);
  });
}

/** Unlinks a driver from their vehicle; refused while the vehicle is on a delivery. */
async function unassignVehicle(driverId) {
  await get(driverId); // 404 if the driver doesn't exist
  await db.withTransaction(async function (client) {
    const { rows } = await client.query('SELECT id FROM vehicles WHERE driver_id = $1', [driverId]);
    if (rows.length === 0) {
      throw conflict('Driver is not assigned to any vehicle');
    }
    await releaseFromVehicle(client, driverId);
  });
}

module.exports = { list, get, create, update, remove, assignVehicle, unassignVehicle };
