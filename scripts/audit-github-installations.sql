-- #1037 — audit the GitHub App installation ids already stored on workspaces.
--
-- Before the fix, the connect callback stored whatever `installation_id` the URL carried (as long as the state verified), so any admin
-- of their own workspace could link ANOTHER organisation's installation. The signature of that attack is ONE installation id linked
-- to workspaces owned by DIFFERENT people. Run read-only against production and review each row by hand: two workspaces of one
-- organisation sharing an installation is legitimate; unrelated owners are not.
--
--   psql "$DATABASE_URL" -f scripts/audit-github-installations.sql

-- 1. Installation ids linked to more than one workspace, with who owns them.
SELECT w.settings -> 'github' ->> 'installation_id'          AS installation_id,
       count(*) OVER (PARTITION BY w.settings -> 'github' ->> 'installation_id') AS workspaces_sharing_it,
       w.id                                                  AS workspace_id,
       w.name                                                AS workspace_name,
       w.created_at,
       (SELECT string_agg(u.email, ', ' ORDER BY u.email)
          FROM memberships m JOIN "user" u ON u.id = m.user_id
         WHERE m.workspace_id = w.id AND m.role = 'admin' AND m.status = 'active') AS admins
  FROM workspaces w
 WHERE w.settings -> 'github' ->> 'installation_id' IS NOT NULL
   AND (SELECT count(*) FROM workspaces x
         WHERE x.settings -> 'github' ->> 'installation_id' = w.settings -> 'github' ->> 'installation_id') > 1
 ORDER BY installation_id, w.created_at;

-- 2. Every workspace with an installation, for a manual pass (newest first): who linked it and what it imports.
SELECT w.id AS workspace_id, w.name, w.settings -> 'github' ->> 'installation_id' AS installation_id,
       w.created_at,
       (SELECT string_agg(u.email, ', ' ORDER BY u.email)
          FROM memberships m JOIN "user" u ON u.id = m.user_id
         WHERE m.workspace_id = w.id AND m.role = 'admin' AND m.status = 'active') AS admins
  FROM workspaces w
 WHERE w.settings -> 'github' ->> 'installation_id' IS NOT NULL
 ORDER BY w.created_at DESC;

-- To UNLINK a workspace that should not have one (after review):
--   UPDATE workspaces SET settings = settings #- '{github,installation_id}' WHERE id = '<workspace uuid>';
