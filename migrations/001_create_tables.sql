-- 001: core tables.
-- Rules live in the database as well as in the code: NOT NULL, UNIQUE, CHECK and FOREIGN KEY
-- constraints still hold if a bug (or a manual SQL session) bypasses the API.

-- Login accounts. Passwords are stored only as bcrypt hashes.
CREATE TABLE users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    role          VARCHAR(20)  NOT NULL CHECK (role IN ('ADMIN', 'DISPATCHER')),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE drivers (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name           VARCHAR(100) NOT NULL,
    phone          VARCHAR(20)  NOT NULL UNIQUE,
    license_number VARCHAR(50)  NOT NULL UNIQUE,
    status         VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    registration_number VARCHAR(20) NOT NULL UNIQUE,
    type                VARCHAR(10) NOT NULL CHECK (type IN ('BIKE', 'VAN', 'TRUCK')),
    status              VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE'
                        CHECK (status IN ('AVAILABLE', 'BUSY', 'OFFLINE', 'INACTIVE')),
    current_latitude    DOUBLE PRECISION CHECK (current_latitude BETWEEN -90 AND 90),
    current_longitude   DOUBLE PRECISION CHECK (current_longitude BETWEEN -180 AND 180),
    location_updated_at TIMESTAMPTZ,
    -- UNIQUE: a driver can be linked to at most one vehicle at a time
    driver_id           BIGINT UNIQUE REFERENCES drivers (id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A position is either fully known or not known at all
    CHECK ((current_latitude IS NULL) = (current_longitude IS NULL))
);

CREATE TABLE customers (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name             VARCHAR(100) NOT NULL,
    phone            VARCHAR(20)  NOT NULL,
    pickup_latitude  DOUBLE PRECISION NOT NULL CHECK (pickup_latitude BETWEEN -90 AND 90),
    pickup_longitude DOUBLE PRECISION NOT NULL CHECK (pickup_longitude BETWEEN -180 AND 180),
    drop_latitude    DOUBLE PRECISION NOT NULL CHECK (drop_latitude BETWEEN -90 AND 90),
    drop_longitude   DOUBLE PRECISION NOT NULL CHECK (drop_longitude BETWEEN -180 AND 180),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE deliveries (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id      BIGINT NOT NULL REFERENCES customers (id),
    vehicle_id       BIGINT REFERENCES vehicles (id),
    driver_id        BIGINT REFERENCES drivers (id),
    status           VARCHAR(20) NOT NULL DEFAULT 'CREATED'
                     CHECK (status IN ('CREATED', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED')),
    -- Each delivery keeps its own route (defaults to the customer's addresses)
    pickup_latitude  DOUBLE PRECISION NOT NULL CHECK (pickup_latitude BETWEEN -90 AND 90),
    pickup_longitude DOUBLE PRECISION NOT NULL CHECK (pickup_longitude BETWEEN -180 AND 180),
    drop_latitude    DOUBLE PRECISION NOT NULL CHECK (drop_latitude BETWEEN -90 AND 90),
    drop_longitude   DOUBLE PRECISION NOT NULL CHECK (drop_longitude BETWEEN -180 AND 180),
    assigned_at      TIMESTAMPTZ,
    delivered_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Once a delivery has been assigned it must name a vehicle and a driver
    -- (CANCELLED may or may not have one, depending on when it was cancelled)
    CHECK (status IN ('CREATED', 'CANCELLED') OR (vehicle_id IS NOT NULL AND driver_id IS NOT NULL)),
    -- delivered_at is set exactly when the delivery is DELIVERED
    CHECK ((status = 'DELIVERED') = (delivered_at IS NOT NULL))
);

-- Append-only GPS trail. The app only ever INSERTs here.
CREATE TABLE location_history (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id  BIGINT NOT NULL REFERENCES vehicles (id),
    latitude    DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude   DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
