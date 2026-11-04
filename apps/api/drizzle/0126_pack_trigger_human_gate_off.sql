-- ticket #1212 (reverses ticket #1183): a built-in pack's agent no longer needs a person to start every run.
--
-- New installs are fixed in the manifests. This is the one-time step for installs that already exist: a binding that
--   (1) was created by an install of a built-in pack that used to set human_gate (pack_install_items, kind 'trigger', action 'created'),
--   (2) is currently ENABLED, and
--   (3) belongs to an agent whose AI mode is 'Your own AI'
-- has its human_gate set to false. Everything else is left alone (a disabled binding, another AI mode, a binding no pack created).
--
-- NOTE on (2): a human-gated pack trigger was installed ENABLED by the installer itself (it was inert), so 'enabled' does not prove a
-- person switched it on. This follows the ruling as written; see the ticket and the PR body for the consequence.
--
-- Safe to re-run: the backup table is keyed by record id (ON CONFLICT DO NOTHING) and only rows it newly records are changed, so a
-- second run changes nothing, and a person who put the gate back on afterwards is not overridden.
-- Reversible: every changed binding id is kept in "migration_1212_pack_trigger_human_gate"; the revert is the UPDATE at the bottom.
-- Record values are keyed by field UUID, so every field is found by api_name inside the workspace's own system databases.

CREATE TABLE IF NOT EXISTS "migration_1212_pack_trigger_human_gate" (
  "record_id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL,
  "human_gate_field_id" uuid NOT NULL,
  "migrated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
WITH changed AS (
INSERT INTO "migration_1212_pack_trigger_human_gate" ("record_id", "workspace_id", "human_gate_field_id")
SELECT b.id, tdb.workspace_id, hg.id
FROM records b
JOIN databases tdb ON tdb.id = b.database_id AND tdb.system_key = 'agent_triggers' AND tdb.is_system
JOIN fields hg ON hg.database_id = tdb.id AND hg.api_name = 'human_gate' AND hg.deleted_at IS NULL
JOIN fields en ON en.database_id = tdb.id AND en.api_name = 'enabled' AND en.deleted_at IS NULL
JOIN databases adb ON adb.workspace_id = tdb.workspace_id AND adb.system_key = 'agents' AND adb.is_system
JOIN fields aim ON aim.database_id = adb.id AND aim.api_name = 'ai_mode' AND aim.deleted_at IS NULL
JOIN relations rel ON rel.database_a_id = tdb.id AND rel.database_b_id = adb.id
JOIN record_links l ON l.relation_id = rel.id AND l.from_record_id = b.id
JOIN records a ON a.id = l.to_record_id AND a.database_id = adb.id AND a.deleted_at IS NULL
JOIN select_options aimo ON aimo.field_id = aim.id AND aimo.id::text = a.values ->> aim.id::text AND aimo.label = 'Your own AI'
WHERE b.deleted_at IS NULL
  AND b.values -> hg.id::text = 'true'::jsonb
  AND b.values -> en.id::text = 'true'::jsonb
  AND EXISTS (
    SELECT 1
    FROM pack_install_items pii
    JOIN pack_installs pi ON pi.id = pii.pack_install_id
    WHERE pii.kind = 'trigger'
      AND pii.action = 'created'
      AND pii.entity_id = b.id
      AND pi.workspace_id = tdb.workspace_id
      AND pi.uninstalled_at IS NULL
      AND pi.slug IN ('agency-os', 'client-portal', 'dev-project-os', 'content-engine', 'book-launch', 'coaching-os', 'consulting-os', 'dev-tracker')
  )
ON CONFLICT ("record_id") DO NOTHING
RETURNING "record_id", "human_gate_field_id"
)
-- Only the rows THIS run newly recorded are changed, so a re-run never undoes a person putting the gate back on afterwards.
UPDATE records r
SET values = jsonb_set(r.values, ARRAY[c.human_gate_field_id::text], 'false'::jsonb), updated_at = now()
FROM changed c
WHERE r.id = c.record_id;

-- REVERT (not run): put the gate back on exactly the bindings this migration changed.
--   UPDATE records r SET values = jsonb_set(r.values, ARRAY[m.human_gate_field_id::text], 'true'::jsonb), updated_at = now()
--   FROM "migration_1212_pack_trigger_human_gate" m WHERE r.id = m.record_id;
--
-- DRY RUN (not run): how many bindings the INSERT above would select, per workspace, without changing anything -- run the SELECT
-- part of the INSERT on its own with `SELECT tdb.workspace_id, count(*)` ... `GROUP BY 1`.
