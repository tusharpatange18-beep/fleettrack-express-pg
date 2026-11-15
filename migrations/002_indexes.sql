-- 002: indexes, each one tied to a query that needs it.
-- PRIMARY KEY and UNIQUE columns are indexed automatically. Foreign keys are NOT: Postgres does
-- not index the referencing column, so joins and lookups on them need explicit indexes.

-- Nearby search and auto-assign: "status = 'AVAILABLE' AND current_latitude BETWEEN ..."
-- The equality column comes first, then the range column (leftmost-prefix rule).
CREATE INDEX idx_vehicles_status_lat ON vehicles (status, current_latitude);

-- "Is this vehicle on an active delivery?" and the deliveries list per status
CREATE INDEX idx_deliveries_vehicle ON deliveries (vehicle_id);
CREATE INDEX idx_deliveries_status ON deliveries (status);
CREATE INDEX idx_deliveries_customer ON deliveries (customer_id);

-- Report: deliveries completed per driver in the last N days
CREATE INDEX idx_deliveries_driver_delivered ON deliveries (driver_id, delivered_at);

-- A vehicle's trail, newest first, optionally limited to a time window
CREATE INDEX idx_location_history_vehicle_time ON location_history (vehicle_id, recorded_at DESC);

-- Database-level guarantee against double assignment: at most ONE active delivery per vehicle.
-- A partial unique index only covers the rows matching its WHERE clause, so any number of
-- finished deliveries can share a vehicle, but two active ones cannot. Even if application code
-- had a race, the second INSERT/UPDATE would fail with a unique violation.
CREATE UNIQUE INDEX uq_deliveries_one_active_per_vehicle
    ON deliveries (vehicle_id)
    WHERE status IN ('ASSIGNED', 'PICKED_UP', 'IN_TRANSIT');
