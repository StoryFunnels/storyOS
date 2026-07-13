-- MN-153: stable, namespaced api-slugs.
-- Spaces get a slug; database slugs become unique per SPACE (not per workspace) and are
-- recomputed deterministically so cross-space name reuse no longer yields "_2".

-- 1. spaces.slug — add nullable, backfill (slugify + dedupe per workspace), then NOT NULL.
ALTER TABLE "spaces" ADD COLUMN "slug" text;--> statement-breakpoint

UPDATE "spaces" s SET "slug" = q.slug
FROM (
  SELECT id, CASE WHEN rn = 1 THEN root ELSE root || '_' || rn END AS slug
  FROM (
    SELECT id, root,
           row_number() OVER (PARTITION BY workspace_id, root ORDER BY created_at, id) AS rn
    FROM (
      SELECT id, workspace_id, created_at,
             COALESCE(NULLIF(left(regexp_replace(regexp_replace(lower(name), '[^a-z0-9]+', '_', 'g'), '(^_+|_+$)', '', 'g'), 50), ''), 'space') AS root
      FROM "spaces"
    ) a
  ) b
) q
WHERE s.id = q.id;--> statement-breakpoint

ALTER TABLE "spaces" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint

-- 2. Drop the old per-workspace uniqueness BEFORE recomputing (so cross-space
--    collapses like contacts/contacts_2 -> contacts don't trip the old index).
DROP INDEX "databases_workspace_slug_uq";--> statement-breakpoint

-- 3. Recompute database api_slug to be unique per SPACE (drops cross-space "_N").
UPDATE "databases" d SET "api_slug" = q.slug
FROM (
  SELECT id, CASE WHEN rn = 1 THEN root ELSE root || '_' || rn END AS slug
  FROM (
    SELECT id, root,
           row_number() OVER (PARTITION BY space_id, root ORDER BY created_at, id) AS rn
    FROM (
      SELECT id, space_id, created_at,
             COALESCE(NULLIF(left(regexp_replace(regexp_replace(lower(name), '[^a-z0-9]+', '_', 'g'), '(^_+|_+$)', '', 'g'), 50), ''), 'database') AS root
      FROM "databases"
    ) a
  ) b
) q
WHERE d.id = q.id;--> statement-breakpoint

-- 4. New uniqueness scope + spaces unique index.
CREATE UNIQUE INDEX "databases_space_slug_uq" ON "databases" USING btree ("space_id","api_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_workspace_slug_uq" ON "spaces" USING btree ("workspace_id","slug");
