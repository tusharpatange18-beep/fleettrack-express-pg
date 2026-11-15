-- 003: great-circle distance in km between two points, as a SQL function.
--
-- Haversine formula (R = 6371 km, the Earth's mean radius):
--   a = sin^2(dLat/2) + cos(lat1) * cos(lat2) * sin^2(dLon/2)
--   d = 2 * R * asin(sqrt(a))
-- with all angles in radians.
--
-- IMMUTABLE: same inputs always give the same output, so Postgres may cache or inline it.
-- LEAST(1, ...) guards against floating-point rounding pushing sqrt(a) slightly above 1,
-- which would make asin() raise an error.
-- (Migration files are kept ASCII-only so they run on databases with any encoding.)
CREATE FUNCTION haversine_km(lat1 DOUBLE PRECISION, lon1 DOUBLE PRECISION,
                             lat2 DOUBLE PRECISION, lon2 DOUBLE PRECISION)
RETURNS DOUBLE PRECISION
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT 2 * 6371 * asin(LEAST(1, sqrt(
          power(sin(radians(lat2 - lat1) / 2), 2)
        + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
    )))
$$;
