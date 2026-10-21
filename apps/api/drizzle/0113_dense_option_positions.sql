-- #961 — one position per option, per choice field: dense 0..n-1 in the CURRENT display order, so a sort by the field, the board's
-- "Field order" columns and every option list agree and nothing visibly moves. Until now two options could share a position (a
-- raw PATCH of `position` never checked, and fields created before positions were assigned by index all sat at the default 0),
-- and every reader then showed the tied ones in whatever order the database returned them.
--
-- The order within a tie is the order a person has been seeing: creation time, then physical row order (ctid), which is what an
-- unordered read returned. Options created in one batch share a created_at, so for those the physical order is the best record there is. Idempotent: a field whose options are
-- already 0..n-1 has no row where the number differs, so a second run writes nothing.
UPDATE select_options o
SET position = r.rn - 1
FROM (
  SELECT id, row_number() OVER (PARTITION BY field_id ORDER BY position, created_at, ctid) AS rn
  FROM select_options
) r
WHERE o.id = r.id AND o.position <> r.rn - 1;
