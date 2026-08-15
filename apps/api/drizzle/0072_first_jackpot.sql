ALTER TABLE "databases" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- #317/#318/#319 — backfill the flag for databases that already exist.
--
-- Without this every existing workspace's Members/Agents/Runs/Agent Triggers
-- would read as ORDINARY databases the moment the code stops matching on name:
-- the Members projection would re-provision a duplicate, and the system four
-- would start appearing in exports and onboarding progress.
--
-- Matching is by name here because that is the only signal that exists in the
-- data — it is exactly what the code did until now, so this reproduces today's
-- behaviour rather than inventing a new one.
--
-- THE ONE HEURISTIC, stated plainly: when a workspace holds SEVERAL databases
-- sharing a system name (precisely the #318 collision), only the OLDEST is
-- flagged. The system database is provisioned on workspace setup / first use,
-- so it is virtually always the earlier row, and the user's colliding database
-- came later. This is a heuristic, not a proof. A workspace where a user
-- created "Members" BEFORE the projection ever ran will flag the wrong row;
-- such an operator can correct it with a one-row UPDATE, and from this
-- migration forward the collision cannot recur, because provisioning sets the
-- flag explicitly and nothing resolves a system database by name again.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY workspace_id, lower(name)
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM "databases"
  WHERE lower(name) IN ('members', 'agents', 'runs', 'agent triggers')
)
UPDATE "databases" AS d
SET "is_system" = true
FROM ranked
WHERE d.id = ranked.id
  AND ranked.rn = 1;
