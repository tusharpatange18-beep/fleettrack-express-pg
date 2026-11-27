const db = require('../db/pool');

const VEHICLE_STATUSES = ['AVAILABLE', 'BUSY', 'OFFLINE', 'INACTIVE'];
const DELIVERY_STATUSES = ['CREATED', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'];

/**
 * Report 1: deliveries completed per driver in the last N days.
 *
 *  - LEFT JOIN keeps drivers with zero deliveries (an INNER JOIN would drop them).
 *  - The date and status filters sit in the ON clause, not in WHERE: a WHERE on del.* would throw
 *    away the NULL rows the LEFT JOIN produced for drivers without deliveries, quietly turning
 *    it back into an inner join.
 *  - COUNT(del.id) counts only matched deliveries (COUNT ignores NULLs); COUNT(*) would count 1
 *    for a driver with none.
 *  - Index idx_deliveries_driver_delivered (driver_id, delivered_at) serves the join + date range.
 */
async function deliveriesPerDriver(days) {
  const { rows } = await db.query(
    `SELECT d.id   AS driver_id,
            d.name AS driver_name,
            COUNT(del.id) AS completed
       FROM drivers d
       LEFT JOIN deliveries del
              ON del.driver_id = d.id
             AND del.status = 'DELIVERED'
             AND del.delivered_at >= now() - make_interval(days => $1::int)
      GROUP BY d.id, d.name
      ORDER BY completed DESC, d.name`,
    [days],
  );

  // snake_case rows -> camelCase JSON
  const result = [];
  for (const row of rows) {
    result.push({ driverId: row.driver_id, driverName: row.driver_name, completed: row.completed });
  }
  return result;
}

/**
 * Report 2: vehicles by status, and how many of them have an active driver.
 * COUNT(*) counts every vehicle in the group; COUNT(dr.id) only those whose LEFT JOIN found an
 * ACTIVE driver.
 */
async function vehiclesByStatus() {
  const { rows } = await db.query(
    `SELECT v.status,
            COUNT(*)     AS vehicles,
            COUNT(dr.id) AS with_active_driver
       FROM vehicles v
       LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.status = 'ACTIVE'
      GROUP BY v.status
      ORDER BY v.status`,
  );

  const result = [];
  for (const row of rows) {
    result.push({ status: row.status, vehicles: row.vehicles, withActiveDriver: row.with_active_driver });
  }
  return result;
}

/** Dashboard counters (same JSON as the Java backend's /api/dashboard/summary). */
async function dashboardSummary() {
  // Promise.all runs the three queries at the same time and waits for all of them
  const [vehicles, deliveries, drivers] = await Promise.all([
    db.query('SELECT status, COUNT(*) AS count FROM vehicles GROUP BY status'),
    db.query('SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status'),
    db.query("SELECT COUNT(*) AS count FROM drivers WHERE status = 'ACTIVE'"),
  ]);

  const vehiclesByStatus = zeroFilled(VEHICLE_STATUSES, vehicles.rows);
  const deliveriesByStatus = zeroFilled(DELIVERY_STATUSES, deliveries.rows);

  // Active = on the road right now
  const activeDeliveries = deliveriesByStatus.ASSIGNED + deliveriesByStatus.PICKED_UP + deliveriesByStatus.IN_TRANSIT;

  return {
    vehiclesByStatus: vehiclesByStatus,
    deliveriesByStatus: deliveriesByStatus,
    activeDeliveries: activeDeliveries,
    activeDrivers: drivers.rows[0].count,
  };
}

/**
 * Builds { STATUS: count } with every status present. GROUP BY only returns statuses that
 * have rows, so we start every status at 0 and then fill in the real counts.
 */
function zeroFilled(statuses, rows) {
  const result = {};
  for (const status of statuses) {
    result[status] = 0;
  }
  for (const row of rows) {
    result[row.status] = row.count;
  }
  return result;
}

module.exports = { deliveriesPerDriver, vehiclesByStatus, dashboardSummary };
