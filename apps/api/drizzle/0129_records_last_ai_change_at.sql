ALTER TABLE "records" ADD COLUMN "last_ai_change_at" timestamp with time zone;--> statement-breakpoint
-- #1204 backfill: the latest change whose STORED provenance was not a person. Two history stores, because neither is complete on
-- its own: activity_events carries record.created (a creation leaves no record_versions row), record_versions carries every update.
-- A NULL activity provenance predates the column and is treated as human, never guessed.
UPDATE "records" r SET "last_ai_change_at" = ai.at
FROM (
	SELECT record_id, max(at) AS at FROM (
		SELECT record_id, created_at AS at FROM "activity_events"
			WHERE record_id IS NOT NULL AND type IN ('record.created', 'record.updated') AND source IN ('agent', 'automation', 'mcp')
		UNION ALL
		SELECT record_id, created_at AS at FROM "record_versions" WHERE source IN ('agent', 'automation', 'mcp')
	) h GROUP BY record_id
) ai
WHERE r."id" = ai.record_id;
