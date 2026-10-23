-- #1041 — two views holding one public token made the public URL resolve to either. Before the unique indexes can exist,
-- every collision is settled: the FIRST holder keeps the token (a live view over a deleted one, then the oldest, then the
-- lowest id) and every other view LOSES it. A form that loses its token goes back to members-only (fail closed: no dead
-- public link); a published view that loses its token is unpublished. Idempotent: with no collisions it touches nothing.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY config -> 'form' ->> 'public_token'
    ORDER BY (deleted_at IS NOT NULL), created_at, id
  ) AS rn
  FROM views
  WHERE config -> 'form' ->> 'public_token' IS NOT NULL
)
UPDATE views v
   SET config = jsonb_set(v.config, '{form}', ((v.config -> 'form') - 'public_token') || '{"access":"members"}'::jsonb)
  FROM ranked r
 WHERE v.id = r.id AND r.rn > 1;--> statement-breakpoint
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY config -> 'share' ->> 'public_token'
    ORDER BY (deleted_at IS NOT NULL), created_at, id
  ) AS rn
  FROM views
  WHERE config -> 'share' ->> 'public_token' IS NOT NULL
)
UPDATE views v
   SET config = jsonb_set(v.config, '{share}', (v.config -> 'share') - 'public_token')
  FROM ranked r
 WHERE v.id = r.id AND r.rn > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "views_form_public_token_uq" ON "views" USING btree (("config" -> 'form' ->> 'public_token')) WHERE "views"."config" -> 'form' ->> 'public_token' IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "views_share_public_token_uq" ON "views" USING btree (("config" -> 'share' ->> 'public_token')) WHERE "views"."config" -> 'share' ->> 'public_token' IS NOT NULL;