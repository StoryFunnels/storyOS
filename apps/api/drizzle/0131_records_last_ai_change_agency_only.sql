-- #1294 (narrows #1204; Otto's ruling on ticket #1205): records.last_ai_change_at means "the last time an AGENT or an MCP
-- connection changed this record". Automation is neutral and a person does not stamp it. Migration 0129 filled the column with
-- the OLD rule (agent, automation, mcp), so this recomputes it from history with the new one. The rule's source list is
-- apps/api/src/records/agency-source.ts (AGENCY_SOURCES); test/last-ai-change.test.ts fails if the list below differs.
--
-- WHAT IT DOES, per record, from the two history stores (activity_events carries record.created, a creation leaves no
-- record_versions row; record_versions carries every update):
--   * the latest agent/mcp change exists          -> that time (an existing value within 2 seconds of it is kept as it is)
--   * no agent/mcp change but an automation one   -> NULL  (this is the narrowing: "only automation changed it")
--   * neither store says anything non-human       -> the existing value is KEPT. Nothing proves it was automation, and a
--                                                    workspace whose history is not captured (Free plan, pruned retention) keeps
--                                                    the live stamp the write path gave it; nulling it would be a guess.
-- Only the one column changes. updated_at is not touched. Old values of every row that changes go to the side table
-- records_last_ai_change_backup_1294 first (same statement), and ON CONFLICT DO NOTHING keeps the FIRST old value, so running
-- this file twice cannot overwrite the backup and the second run changes nothing.
--
-- REVERT (restores the old values; skips a row an agent or MCP has stamped since, so it never undoes a live write):
--   UPDATE "records" r SET "last_ai_change_at" = b.old_value
--   FROM "records_last_ai_change_backup_1294" b
--   WHERE r."id" = b.record_id AND r."last_ai_change_at" IS NOT DISTINCT FROM b.new_value;
-- When the verifier has accepted the result the backup can go:  DROP TABLE "records_last_ai_change_backup_1294";
--
-- DRY RUN for production (read only; changes nothing). Run it BEFORE the deploy and again after: the second run must show
-- would_null = 0 and would_move = 0.
-- DRY-RUN-BEGIN
-- WITH hist AS (
--   SELECT record_id,
--          max(at) FILTER (WHERE source IN ('agent', 'mcp')) AS agency_at,
--          bool_or(source = 'automation') AS has_automation
--   FROM (
--     SELECT record_id, created_at AS at, source FROM "activity_events"
--       WHERE record_id IS NOT NULL AND type IN ('record.created', 'record.updated')
--     UNION ALL
--     SELECT record_id, created_at AS at, source FROM "record_versions"
--   ) h GROUP BY record_id
-- ), target AS (
--   SELECT r.id, r.last_ai_change_at AS old_value,
--          CASE WHEN h.agency_at IS NOT NULL
--                 THEN CASE WHEN r.last_ai_change_at IS NOT NULL AND abs(extract(epoch FROM (r.last_ai_change_at - h.agency_at))) < 2
--                           THEN r.last_ai_change_at ELSE h.agency_at END
--               WHEN h.has_automation THEN NULL
--               ELSE r.last_ai_change_at END AS new_value,
--          h.record_id IS NULL AS no_history
--   FROM "records" r LEFT JOIN hist h ON h.record_id = r.id
-- )
-- SELECT count(*) FILTER (WHERE old_value IS NOT NULL) AS stamped_now,
--        count(*) FILTER (WHERE old_value IS NOT NULL AND new_value IS NULL) AS would_null,
--        count(*) FILTER (WHERE old_value IS NOT NULL AND new_value IS NOT NULL AND new_value <> old_value) AS would_move,
--        count(*) FILTER (WHERE old_value IS NULL AND new_value IS NOT NULL) AS would_set,
--        count(*) FILTER (WHERE old_value IS NOT NULL AND new_value = old_value) AS kept,
--        count(*) FILTER (WHERE old_value IS NOT NULL AND new_value = old_value AND no_history) AS kept_without_history
-- FROM target;
-- DRY-RUN-END
CREATE TABLE IF NOT EXISTS "records_last_ai_change_backup_1294" (
	"record_id" uuid PRIMARY KEY NOT NULL,
	"old_value" timestamp with time zone,
	"new_value" timestamp with time zone,
	"recomputed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
WITH hist AS (
	SELECT record_id,
	       max(at) FILTER (WHERE source IN ('agent', 'mcp')) AS agency_at,
	       bool_or(source = 'automation') AS has_automation
	FROM (
		SELECT record_id, created_at AS at, source FROM "activity_events"
			WHERE record_id IS NOT NULL AND type IN ('record.created', 'record.updated')
		UNION ALL
		SELECT record_id, created_at AS at, source FROM "record_versions"
	) h GROUP BY record_id
), target AS (
	SELECT r.id, r.last_ai_change_at AS old_value,
	       CASE WHEN h.agency_at IS NOT NULL
	              THEN CASE WHEN r.last_ai_change_at IS NOT NULL AND abs(extract(epoch FROM (r.last_ai_change_at - h.agency_at))) < 2
	                        THEN r.last_ai_change_at ELSE h.agency_at END
	            WHEN h.has_automation THEN NULL
	            ELSE r.last_ai_change_at END AS new_value
	FROM "records" r LEFT JOIN hist h ON h.record_id = r.id
), changed AS (
	SELECT id, old_value, new_value FROM target WHERE new_value IS DISTINCT FROM old_value
), saved AS (
	INSERT INTO "records_last_ai_change_backup_1294" (record_id, old_value, new_value)
	SELECT id, old_value, new_value FROM changed
	ON CONFLICT (record_id) DO NOTHING
)
UPDATE "records" r SET "last_ai_change_at" = c.new_value
FROM changed c
WHERE r."id" = c.id;
