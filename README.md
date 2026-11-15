# FleetTrack (Node.js + PostgreSQL)

A fleet-management REST API for a delivery business: vehicles, drivers, customers and deliveries, with a strict delivery state machine, transactional assignment, nearby-vehicle search written in SQL, an append-only GPS history and reporting queries.

It is a rewrite of the [Java/Spring Boot FleetTrack](https://github.com/tusharpatange18-beep/FleetTrack) with the **same API**, so the same React frontend works with either backend.

**Stack:** Node.js 20+ · Express 5 · PostgreSQL with the `pg` driver and **raw SQL** (no ORM) · plain numbered `.sql` migrations · JWT + bcrypt · zod validation · Jest + supertest against a real PostgreSQL

---

## Quick start

```bash
npm install
cp .env.example .env          # then set JWT_SECRET (instructions inside)

# Terminal 1: a local PostgreSQL on port 5433, no installation needed (Ctrl+C to stop)
npm run db:local

# Terminal 2
npm run migrate               # creates the tables (safe to run again)
npm run dev                   # http://localhost:3000, restarts on file changes
```

Already have PostgreSQL? Skip `db:local` and point `DATABASE_URL` at it.

Try it:

```bash
curl -X POST localhost:3000/api/auth/register -H 'Content-Type: application/json' \
     -d '{"username":"admin","password":"admin12345","role":"ADMIN"}'
curl -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' \
     -d '{"username":"admin","password":"admin12345"}'          # -> {"token":"eyJ..."}
```

**With the web UI:** start the FleetTrack React frontend with `FLEETTRACK_API=http://localhost:3000 npm run dev` (from its `frontend/` folder), then open http://localhost:5173.

## Project structure

```
migrations/            001_create_tables.sql, 002_indexes.sql, 003_haversine_function.sql
scripts/local-db.js    starts a real PostgreSQL from node_modules (embedded-postgres)
src/
  server.js            loads .env, creates the pool, starts listening, graceful shutdown
  app.js               builds the Express app: routes, auth, error handler (no listen, for tests)
  config.js            reads and checks environment variables
  schemas.js           zod schemas for every request body and query string
  db/pool.js           pg Pool, query(), withTransaction()
  db/migrate.js        runs migrations/*.sql in order, records them in schema_migrations
  middleware/          auth.js (JWT + roles), validate.js (zod), errorHandler.js
  routes/              HTTP layer: URL, validation, role, then call a service
  services/            business rules and all SQL
tests/                 Jest + supertest; globalSetup starts a throwaway PostgreSQL
```

**Request flow:** `route` (validate input, check role) → `service` (rules + SQL) → PostgreSQL. Services throw `HttpError(status, message)`; one error handler turns every error into the same JSON body:

```json
{ "timestamp": "...", "status": 409, "error": "Conflict", "message": "Vehicle is not AVAILABLE (status: BUSY)", "path": "/api/deliveries/7/assign" }
```

## Database

| Table | Notes |
|---|---|
| `users` | `username` UNIQUE, `password_hash` (bcrypt), `role` CHECK in (ADMIN, DISPATCHER) |
| `drivers` | `phone` and `license_number` UNIQUE, `status` CHECK in (ACTIVE, INACTIVE) |
| `vehicles` | `registration_number` UNIQUE, `type` and `status` CHECKs, lat/lng range CHECKs, "both or neither" CHECK on the position, `driver_id` UNIQUE FK (one vehicle per driver) |
| `customers` | saved pickup and drop coordinates |
| `deliveries` | FKs to customer, vehicle and driver; own pickup/drop; CHECK that an assigned delivery names a vehicle and a driver; CHECK that `delivered_at` is set exactly when DELIVERED |
| `location_history` | append-only GPS trail |

Indexes (`002_indexes.sql`), each tied to a query:

| Index | Serves |
|---|---|
| `vehicles (status, current_latitude)` | nearby search and auto-assign: equality column first, then the range column |
| `deliveries (vehicle_id)`, `(status)`, `(customer_id)` | "is this vehicle on a job?", lists by status, FK lookups. PostgreSQL does **not** index foreign keys automatically |
| `deliveries (driver_id, delivered_at)` | report: deliveries per driver in the last N days |
| `location_history (vehicle_id, recorded_at DESC)` | a vehicle's trail, newest first |
| **partial unique** `deliveries (vehicle_id) WHERE status IN (ASSIGNED, PICKED_UP, IN_TRANSIT)` | at most one active delivery per vehicle, guaranteed by the database |

## Delivery state machine

```
CREATED --assign--> ASSIGNED --> PICKED_UP --> IN_TRANSIT --> DELIVERED
   |                    |
   +----> CANCELLED <---+
```

- Any other jump returns **409**. `ASSIGNED` can only be reached through `/assign` or `/auto-assign`, so the status endpoint returns 400 for it.
- Assignment requires: the delivery is CREATED, the vehicle is AVAILABLE, the vehicle has a driver, and that driver is ACTIVE. The vehicle then becomes BUSY.
- DELIVERED or CANCELLED makes a BUSY vehicle AVAILABLE again.

## API

All `/api/**` routes except `/api/auth/**` need `Authorization: Bearer <token>` and the ADMIN or DISPATCHER role.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | first user may be ADMIN; later only an admin can create admins |
| GET, POST | `/api/vehicles` | list is paginated: `?page=0&size=20&sort=id,desc` |
| GET, PATCH, DELETE | `/api/vehicles/:id` | PATCH is partial; DELETE is a soft delete (INACTIVE) |
| PATCH | `/api/vehicles/:id/location` | moves the vehicle and appends to its history |
| GET | `/api/vehicles/:id/locations?from=&to=` | history, newest first |
| GET | `/api/vehicles/nearby?latitude=&longitude=&radiusKm=` | Haversine in SQL |
| GET | `/api/drivers`, `/api/drivers/:id` | dispatchers may read |
| POST, PATCH, DELETE | `/api/drivers`, `/api/drivers/:id` | ADMIN only |
| PATCH | `/api/drivers/:driverId/assign-vehicle/:vehicleId` | ADMIN only |
| DELETE | `/api/drivers/:id/vehicle` | unassign, ADMIN only |
| GET, POST | `/api/customers`, GET `/api/customers/:id` | |
| GET, POST | `/api/deliveries`, GET `/api/deliveries/:id` | route defaults to the customer's addresses |
| PATCH | `/api/deliveries/:id/assign?vehicleId=` | transaction + row locks |
| POST | `/api/deliveries/:id/auto-assign?radiusKm=` | nearest suitable vehicle, `FOR UPDATE SKIP LOCKED` |
| PATCH | `/api/deliveries/:id/status` | state machine |
| GET | `/api/reports/deliveries-per-driver?days=7` | JOIN + GROUP BY |
| GET | `/api/reports/vehicles-by-status` | JOIN + GROUP BY |
| GET | `/api/dashboard/summary` | counters for the UI |
| GET | `/health` | public; also checks the database |

## The interesting SQL

**Assignment in a transaction** (`deliveryService.assign`):

```sql
BEGIN;
SELECT * FROM deliveries WHERE id = $1 FOR UPDATE;   -- lock the delivery row
SELECT * FROM vehicles   WHERE id = $2 FOR UPDATE;   -- lock the vehicle row
-- check: delivery CREATED, vehicle AVAILABLE, driver present and ACTIVE
UPDATE deliveries SET status = 'ASSIGNED', vehicle_id = $2, driver_id = $3, assigned_at = now() WHERE id = $1;
UPDATE vehicles   SET status = 'BUSY' WHERE id = $2;
COMMIT;                                               -- locks released; any error -> ROLLBACK
```

Two dispatchers assigning the same vehicle: the second blocks on `FOR UPDATE` until the first commits, then sees BUSY and gets 409. Locks are always taken delivery-first, vehicle-second, so two transactions can never wait on each other in a cycle (deadlock).

**Two layers of protection.** If the lock were missing, the partial unique index would still reject the second active delivery (unique violation, returned as 409). A test proves exactly one of 8 parallel assignments wins.

**Nearby vehicles** (`vehicleService.nearby`):

```sql
SELECT v.id, ..., haversine_km($1, $2, v.current_latitude, v.current_longitude) AS distance_km
  FROM vehicles v
 WHERE v.status = 'AVAILABLE'                                          -- index, equality part
   AND v.current_latitude BETWEEN $1 - $3 / 111.045 AND $1 + $3 / 111.045  -- index, range part
   AND v.location_updated_at >= now() - make_interval(mins => $4)     -- skip stale positions
   AND haversine_km($1, $2, v.current_latitude, v.current_longitude) <= $3  -- exact distance
 ORDER BY distance_km, v.id;
```

One degree of latitude is about 111 km everywhere, so the latitude band contains every point within the radius and lets the index cut the scan down. The exact Haversine check then removes the band's extra points. `haversine_km` is a SQL function defined in `003_haversine_function.sql`.

**Auto-assign** uses the same query with `JOIN drivers ... AND d.status = 'ACTIVE'`, `LIMIT 1` and `FOR UPDATE OF v SKIP LOCKED`. If another transaction is assigning the nearest vehicle right now, this one skips it and locks the next nearest instead of waiting, so parallel auto-assigns spread over different vehicles.

**No lost updates from GPS pings.** A location update is a single `UPDATE vehicles SET current_latitude, current_longitude, location_updated_at`. It never rewrites `status`, so it cannot undo a concurrent assignment.

**Report: deliveries per driver** (`reportService.deliveriesPerDriver`): a `LEFT JOIN` keeps drivers with zero deliveries. The date and status filters sit in the `ON` clause, because putting them in `WHERE` would drop those drivers again. `COUNT(del.id)` ignores the NULLs that the left join produces.

## Testing

```bash
npm test
```

`tests/globalSetup.js` starts a throwaway PostgreSQL, runs the real migrations, and every test begins with empty tables (`TRUNCATE ... RESTART IDENTITY CASCADE`). 86 tests cover:

- auth: bcrypt hashes, 401/403, first-admin rule, deleted user's token
- validation and every error code
- vehicle CRUD and location history
- nearby search, including stale positions and a known distance
- all 36 state-machine pairs, plus every assignment rule and rollback
- auto-assign
- concurrency: 8 parallel assigns with one winner, parallel auto-assigns on distinct vehicles, the partial unique index, and pings during assignment
- both reports
- the database constraints themselves

CI (GitHub Actions) runs the same suite against a `postgres:17` service container.

## Design decisions

- **Raw SQL with `pg`, no ORM.** Every query is visible and explainable, and Postgres features such as partial indexes, `FOR UPDATE SKIP LOCKED`, `make_interval` and SQL functions are used directly. All values go through `$1` placeholders, so user input never becomes part of the SQL text (no SQL injection). The only dynamic SQL fragment is `ORDER BY`, chosen from a whitelist.
- **Rules in two places.** zod and the services give friendly errors; database constraints guarantee integrity even when code is bypassed.
- **`withTransaction()`** runs everything on one pooled connection between `BEGIN` and `COMMIT`, rolls back on any error, and always releases the connection.
- **BIGINT parsing.** `pg` returns BIGINT as a string by default, because it can exceed JavaScript's safe integer range. Ids and counts here never come close, so `pool.js` parses them to numbers.
- **The token is checked against the database** on every request, so deleting a user or changing their role takes effect immediately.
- **The first-admin race.** Registration takes `pg_advisory_xact_lock`, so two simultaneous "first users" cannot both become ADMIN.

## Limitations

- There is no refresh token and no login rate limiting.
- Distances are straight-line, not road distance.
- Location history grows without limit; at scale it would need monthly partitions or a retention job.
- Offset pagination slows down on deep pages; keyset pagination (`WHERE id > $last`) would fix it.
