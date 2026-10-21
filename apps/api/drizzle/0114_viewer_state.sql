CREATE TABLE "viewer_state" (
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "viewer_state_user_id_kind_target_id_pk" PRIMARY KEY("user_id","kind","target_id")
);
--> statement-breakpoint
ALTER TABLE "viewer_state" ADD CONSTRAINT "viewer_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "viewer_state_workspace_user_idx" ON "viewer_state" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "viewer_state_target_idx" ON "viewer_state" USING btree ("kind","target_id");--> statement-breakpoint
-- Backfill (ticket #973): every personal filter and personal collection view in the old per-user blob becomes ONE row. The old key
-- is a view id / relation-field id; the row also needs the WORKSPACE, which the blob never recorded, so it is resolved through the
-- view's / field's database. An entry whose view or field no longer exists (hard-deleted since) has nothing to attach to and is
-- dropped; a soft-deleted one is kept, so a restore brings the override back. ON CONFLICT DO NOTHING makes a re-run a no-op.
INSERT INTO viewer_state (user_id, workspace_id, kind, target_id, data, updated_at)
SELECT p.user_id, d.workspace_id, 'view_filter', v.id, e.value, now()
FROM user_preferences p
CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(p.preferences->'viewFilters') = 'object' THEN p.preferences->'viewFilters' ELSE '{}'::jsonb END) e
JOIN views v ON v.id::text = e.key
JOIN databases d ON d.id = v.database_id
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO viewer_state (user_id, workspace_id, kind, target_id, data, updated_at)
SELECT p.user_id, d.workspace_id, 'collection_view', f.id, e.value, now()
FROM user_preferences p
CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(p.preferences->'collectionFilters') = 'object' THEN p.preferences->'collectionFilters' ELSE '{}'::jsonb END) e
JOIN fields f ON f.id::text = e.key
JOIN databases d ON d.id = f.database_id
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Then the two keys leave the blob: `viewer_state` is the only home for these overrides from here on.
UPDATE user_preferences
SET preferences = preferences - 'viewFilters' - 'collectionFilters'
WHERE preferences ?| ARRAY['viewFilters', 'collectionFilters'];
