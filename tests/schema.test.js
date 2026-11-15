// The database enforces the rules on its own, even when the API is bypassed.
const db = require('../src/db/pool');
const { setupTestApp } = require('./helpers');

setupTestApp();

test('CHECK constraint rejects an unknown status', async () => {
  await expect(db.query("INSERT INTO vehicles (registration_number, type, status) VALUES ('X1', 'VAN', 'FLYING')"))
    .rejects.toMatchObject({ code: '23514' });
});

test('latitude without longitude is rejected', async () => {
  await expect(db.query("INSERT INTO vehicles (registration_number, type, current_latitude) VALUES ('X2', 'VAN', 18.5)"))
    .rejects.toMatchObject({ code: '23514' });
});

test('an assigned delivery must name a vehicle and a driver', async () => {
  const { rows } = await db.query(
    "INSERT INTO customers (name, phone, pickup_latitude, pickup_longitude, drop_latitude, drop_longitude) VALUES ('C', '90000', 1, 1, 2, 2) RETURNING id",
  );
  await expect(db.query(
    "INSERT INTO deliveries (customer_id, status, pickup_latitude, pickup_longitude, drop_latitude, drop_longitude) VALUES ($1, 'ASSIGNED', 1, 1, 2, 2)",
    [rows[0].id],
  )).rejects.toMatchObject({ code: '23514' });
});

test('foreign key rejects a delivery for a missing customer', async () => {
  await expect(db.query(
    'INSERT INTO deliveries (customer_id, pickup_latitude, pickup_longitude, drop_latitude, drop_longitude) VALUES (999, 1, 1, 2, 2)',
  )).rejects.toMatchObject({ code: '23503' });
});

test('every migration was recorded', async () => {
  const { rows } = await db.query('SELECT version FROM schema_migrations ORDER BY version');
  expect(rows.map(r => r.version)).toEqual(['001_create_tables.sql', '002_indexes.sql', '003_haversine_function.sql']);
});
