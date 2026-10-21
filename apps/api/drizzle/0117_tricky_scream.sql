ALTER TABLE "select_options" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "select_options" ADD CONSTRAINT "select_options_category_check" CHECK ("select_options"."category" IS NULL OR "select_options"."category" IN ('backlog', 'unstarted', 'started', 'completed', 'canceled'));--> statement-breakpoint
-- #1014 — backfill: every option of a WORKFLOW field gets the category the web used to guess at read time (`isCompletedState`), once, so "finished" is
-- data from here on. The rule is `inferStateCategory` in packages/schemas (a test runs this statement against that function for a vocabulary of
-- labels): a finished label -> completed (cancelled / canceled -> canceled); the LAST option of a workflow with more than one -> completed (the
-- terminal state of the flow, as the old rule treated it); backlog / triage / icebox / someday -> backlog; in progress / in review / review /
-- doing / started / active / wip -> started; everything else -> unstarted. Select options stay NULL (a select is not an ordered flow).
-- Idempotent: only rows with no category are written.
UPDATE select_options o
SET category = CASE
  WHEN btrim(o.label) ~* '^cancell?ed$' THEN 'canceled'
  WHEN btrim(o.label) ~* '^(done|complete|completed|closed|shipped|resolved|archived)$' THEN 'completed'
  WHEN r.is_last THEN 'completed'
  WHEN btrim(o.label) ~* '^(backlog|triage|icebox|someday)$' THEN 'backlog'
  WHEN btrim(o.label) ~* '^(in progress|in review|review|doing|started|active|wip)$' THEN 'started'
  ELSE 'unstarted'
END
FROM (
  SELECT so.id,
         (count(*) OVER (PARTITION BY so.field_id) > 1
          AND row_number() OVER (PARTITION BY so.field_id ORDER BY so.position DESC, so.id DESC) = 1) AS is_last
  FROM select_options so
  JOIN fields f ON f.id = so.field_id
  -- compared as text: on a fresh database the migrations run in ONE transaction, and Postgres refuses to use an enum value (here 'workflow')
  -- that was added earlier in that same transaction.
  WHERE f.type::text = 'workflow'
) r
WHERE o.id = r.id AND o.category IS NULL;
