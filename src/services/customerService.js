const db = require('../db/pool');
const { notFound } = require('../errors');
const { orderBy, toPage } = require('./pagination');

/** Database row (snake_case) -> API JSON (camelCase). */
function mapCustomer(r) {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    pickupLatitude: r.pickup_latitude,
    pickupLongitude: r.pickup_longitude,
    dropLatitude: r.drop_latitude,
    dropLongitude: r.drop_longitude,
  };
}

/** One page of customers. */
async function list(paging) {
  const { rows } = await db.query(
    `SELECT * FROM customers ${orderBy(paging.sort)} LIMIT $1 OFFSET $2`,
    [paging.size, paging.page * paging.size],
  );
  const count = await db.query('SELECT COUNT(*) AS total FROM customers');
  return toPage(rows, count.rows[0].total, paging, mapCustomer);
}

async function get(id) {
  const { rows } = await db.query('SELECT * FROM customers WHERE id = $1', [id]);
  if (rows.length === 0) {
    throw notFound(`Customer not found with id: ${id}`);
  }
  return mapCustomer(rows[0]);
}

/** Saves a customer with their usual pickup and drop addresses. */
async function create(c) {
  const { rows } = await db.query(
    `INSERT INTO customers (name, phone, pickup_latitude, pickup_longitude, drop_latitude, drop_longitude)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [c.name, c.phone, c.pickupLatitude, c.pickupLongitude, c.dropLatitude, c.dropLongitude],
  );
  return mapCustomer(rows[0]);
}

module.exports = { list, get, create };
