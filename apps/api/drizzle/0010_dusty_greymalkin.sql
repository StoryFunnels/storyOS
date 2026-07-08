-- ADR-0007 data migration: guest space_ids become commenter grants
INSERT INTO access_grants (workspace_id, user_id, space_id, role)
SELECT m.workspace_id, m.user_id, unnest(m.space_ids), 'commenter'::access_role
FROM memberships m
WHERE m.role = 'guest' AND m.space_ids IS NOT NULL;--> statement-breakpoint
UPDATE invites SET grants = (
  SELECT jsonb_agg(jsonb_build_object('space_id', sid, 'role', 'commenter'))
  FROM unnest(invites.space_ids) AS sid
) WHERE space_ids IS NOT NULL AND accepted_at IS NULL;--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "space_ids";--> statement-breakpoint
ALTER TABLE "memberships" DROP COLUMN "space_ids";