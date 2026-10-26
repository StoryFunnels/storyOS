ALTER TABLE "databases" ADD COLUMN "system_key" text;--> statement-breakpoint
-- #1063 — give every EXISTING system database its key. A system database was found by its display name; from now on it is found by this
-- key. Only rows already flagged is_system are touched, so a person's own database called "Runs" or "Members" gets no key and is never
-- mistaken for one. If a workspace somehow holds two flagged rows with the same name (a half-applied backfill, a restored snapshot) the
-- OLDEST keeps the key, the same tie-break the name lookup used (createdAt, id), and the others stay keyless rather than violate the
-- unique index below. A flagged row with any other name is left keyless on purpose: nothing resolves it, and guessing would be worse.
WITH ranked AS (
  SELECT id,
    CASE lower(name)
      WHEN 'agents' THEN 'agents'
      WHEN 'runs' THEN 'agent_runs'
      WHEN 'agent triggers' THEN 'agent_triggers'
      WHEN 'members' THEN 'members'
    END AS key,
    row_number() OVER (
      PARTITION BY workspace_id, lower(name)
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM "databases"
  WHERE is_system = true AND lower(name) IN ('agents', 'runs', 'agent triggers', 'members')
)
UPDATE "databases" d SET system_key = ranked.key FROM ranked WHERE d.id = ranked.id AND ranked.rn = 1;--> statement-breakpoint
CREATE UNIQUE INDEX "databases_workspace_system_key_uq" ON "databases" USING btree ("workspace_id","system_key") WHERE "databases"."system_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_system_key_valid" CHECK ("databases"."system_key" IS NULL OR ("databases"."is_system" AND "databases"."system_key" IN ('agents', 'agent_triggers', 'agent_runs', 'members')));