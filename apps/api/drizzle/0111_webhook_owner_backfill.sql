-- #920 — a webhook acts on its creator's behalf, so every webhook needs a creator.
-- created_by was recorded at create time, but rows from before that, or created by a service, may have none. There is no
-- audit-log entry for a webhook's creation to recover it from, so the fallback is the WORKSPACE OWNER: the admin who has held
-- the role longest (earliest active admin membership). Rows that already have a creator are left alone. A workspace with
-- no active admin keeps NULL, which the dispatcher treats as "no owner": paused until an admin takes it over.
UPDATE webhook_subscriptions w
SET created_by = (
  SELECT m.user_id
  FROM memberships m
  WHERE m.workspace_id = w.workspace_id AND m.role = 'admin' AND m.status = 'active'
  ORDER BY m.created_at ASC, m.id ASC
  LIMIT 1
)
WHERE w.created_by IS NULL;
