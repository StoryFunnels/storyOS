-- MN-087: backfill per-database sequential public record numbers. Runs after 0021
-- (which adds the 'number' column). Deliberately does NOT insert any field of the
-- new 'id' enum type — Postgres forbids using a freshly-added enum value in the same
-- transaction the value was added in, and the migrator runs all pending migrations in
-- one transaction. Retrofitting the 'id' system field onto existing databases happens
-- post-migrate in application boot (main.ts), in its own transaction.

-- Number existing records by creation order within each database (soft-deleted rows
-- keep a number too, so ids never shift when something is trashed).
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY database_id ORDER BY created_at, id) AS rn
  FROM records
)
UPDATE records r SET number = numbered.rn FROM numbered WHERE r.id = numbered.id;
--> statement-breakpoint
-- Point each database's allocator at its current high-water mark.
UPDATE databases d SET record_counter = COALESCE(
  (SELECT MAX(number) FROM records r WHERE r.database_id = d.id), 0
);
