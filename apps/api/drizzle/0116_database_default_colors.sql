-- #1016 — a database stored as 'gray' gets its id-derived palette colour, once. Until now DatabasesService.create() picked a RANDOM colour from all
-- fifteen names (about one new database in fifteen landed on 'gray', which then drew as the "no colour" grey), and an API caller could pass 'gray'.
-- After this, new databases get the default at insert and grey is an ordinary choice a person makes.
--
-- The colour is the SAME function the app draws with (packages/schemas `defaultEntityColor`): FNV-1a over the id's characters, modulo the eight
-- default names in the order the web fixed (gold, blue, green, red, purple, teal, orange, brown). It is written here in SQL (a recursive walk over the characters; the multiply is 32-bit, kept by masking) and a test runs this
-- exact statement against the JavaScript function for a spread of ids, so the two cannot disagree.
--
-- Only 'gray' rows change. NULL rows (databases from before MN-299) are left NULL: they already resolve to this same colour at read time.
-- Idempotent in the only sense that matters: once run there is no 'gray' left from the old default, and a later deliberate grey is not
-- touched because a migration runs once.
WITH RECURSIVE walk(id, s, i, h) AS (
  SELECT id, id::text, 1, 2166136261::bigint FROM databases WHERE color = 'gray'
  UNION ALL
  SELECT id, s, i + 1, ((h # ascii(substr(s, i, 1))::bigint) * 16777619) & 4294967295
  FROM walk
  WHERE i <= length(s)
),
hashed AS (
  SELECT id, h FROM walk WHERE i = length(s) + 1
)
UPDATE databases d
SET color = (ARRAY['gold', 'blue', 'green', 'red', 'purple', 'teal', 'orange', 'brown'])[(hashed.h % 8)::int + 1]
FROM hashed
WHERE d.id = hashed.id;
