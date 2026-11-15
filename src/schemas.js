// Request validation schemas (zod). Each one describes exactly what an endpoint accepts;
// unknown fields are stripped, and query-string numbers are converted with z.coerce.
const { z } = require('zod');

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const id = z.coerce.number().int().positive();

const VEHICLE_TYPES = ['BIKE', 'VAN', 'TRUCK'];
const DELIVERY_STATUSES = ['CREATED', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'];
// Accept "van" as well as "VAN", like the Java version
const upperEnum = values => z.string().transform(s => s.toUpperCase()).pipe(z.enum(values));

const idParam = z.object({ id });

const pagination = z.object({
  page: z.coerce.number().int().min(0).default(0),
  size: z.coerce.number().int().min(1).max(500).default(20),
  // Only the id column is sortable; anything else would need a whitelist to avoid SQL injection
  sort: z.enum(['id', 'id,asc', 'id,desc']).default('id'),
});

// ---- auth ----
const register = z.object({
  username: z.string().min(3).max(50).regex(/^[A-Za-z0-9._-]+$/, "may contain only letters, digits, '.', '_' and '-'"),
  // bcrypt only uses the first 72 bytes of a password; reject longer ones instead of silently truncating
  password: z.string().min(8).max(72),
  role: upperEnum(['ADMIN', 'DISPATCHER']).optional(),
});
const login = z.object({ username: z.string().min(1), password: z.string().min(1) });

// ---- vehicles ----
const vehicleCreate = z.object({
  registrationNumber: z.string().trim().min(1).max(20),
  type: upperEnum(VEHICLE_TYPES),
  // BUSY belongs to the delivery flow and INACTIVE to DELETE, so users may only pick these
  status: upperEnum(['AVAILABLE', 'OFFLINE']).optional(),
});
const vehicleUpdate = vehicleCreate.partial();
const location = z.object({ latitude, longitude });
const nearbyQuery = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().max(500).default(10),
});
const historyQuery = pagination.extend({
  from: z.iso.datetime({ offset: true, local: true }).optional(),
  to: z.iso.datetime({ offset: true, local: true }).optional(),
  size: z.coerce.number().int().min(1).max(500).default(50),
});

// ---- drivers ----
const driverCreate = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(5).max(20),
  licenseNumber: z.string().trim().min(1).max(50),
  status: upperEnum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});
const driverUpdate = driverCreate.partial();
const driverVehicleParams = z.object({ driverId: id, vehicleId: id });

// ---- customers ----
const customerCreate = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(5).max(20),
  pickupLatitude: latitude,
  pickupLongitude: longitude,
  dropLatitude: latitude,
  dropLongitude: longitude,
});

// ---- deliveries ----
const deliveryCreate = z.object({
  customerId: z.number().int().positive(),
  pickupLatitude: latitude.optional(),
  pickupLongitude: longitude.optional(),
  dropLatitude: latitude.optional(),
  dropLongitude: longitude.optional(),
})
  .refine(d => (d.pickupLatitude === undefined) === (d.pickupLongitude === undefined),
    { message: 'pickupLatitude and pickupLongitude must be sent together', path: ['pickupLatitude'] })
  .refine(d => (d.dropLatitude === undefined) === (d.dropLongitude === undefined),
    { message: 'dropLatitude and dropLongitude must be sent together', path: ['dropLatitude'] });
const assignQuery = z.object({ vehicleId: id });
const autoAssignQuery = z.object({ radiusKm: z.coerce.number().positive().max(500).optional() });
const statusUpdate = z.object({ status: upperEnum(DELIVERY_STATUSES) });

// ---- reports ----
const daysQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(7) });

module.exports = {
  idParam, pagination,
  register, login,
  vehicleCreate, vehicleUpdate, location, nearbyQuery, historyQuery,
  driverCreate, driverUpdate, driverVehicleParams,
  customerCreate,
  deliveryCreate, assignQuery, autoAssignQuery, statusUpdate,
  daysQuery,
};
