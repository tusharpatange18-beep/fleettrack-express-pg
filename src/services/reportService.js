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
  return rows.map(r => ({ driverId: r.driver_id, driverName: r.driver_name, completed: r.completed }));
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
  return rows.map(r => ({ status: r.status, vehicles: r.vehicles, withActiveDriver: r.with_active_driver }));
}

/** Dashboard counters (same JSON as the Java backend's /api/dashboard/summary). */
async function dashboardSummary() {
  const [vehicles, deliveries, drivers] = await Promise.all([
    db.query('SELECT status, COUNT(*) AS count FROM vehicles GROUP BY status'),
    db.query('SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status'),
    db.query("SELECT COUNT(*) AS count FROM drivers WHERE status = 'ACTIVE'"),
  ]);
  const vehiclesByStatus = zeroFilled(VEHICLE_STATUSES, vehicles.rows);
  const deliveriesByStatus = zeroFilled(DELIVERY_STATUSES, deliveries.rows);
  return {
    vehiclesByStatus,
    deliveriesByStatus,
    activeDeliveries: deliveriesByStatus.ASSIGNED + deliveriesByStatus.PICKED_UP + deliveriesByStatus.IN_TRANSIT,
    activeDrivers: drivers.rows[0].count,
  };
}

// Every status appears, with 0 when GROUP BY returned no row for it
function zeroFilled(statuses, rows) {
  const result = Object.fromEntries(statuses.map(s => [s, 0]));
  for (const row of rows) result[row.status] = row.count;
  return result;
}

module.exports = { deliveriesPerDriver, vehiclesByStatus, dashboardSummary };
