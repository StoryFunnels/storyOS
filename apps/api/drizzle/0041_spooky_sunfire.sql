CREATE TABLE "usage_counters" (
	"workspace_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"metric" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_counters_uq" ON "usage_counters" USING btree ("workspace_id","period_start","metric");--> statement-breakpoint
-- Nullable first: existing rows have no workspace_id yet. Backfill via the
-- automations->databases chain, then close the column, matching the
-- add-backfill-constrain pattern used by 0022's record-number backfill.
ALTER TABLE "automation_runs" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
UPDATE automation_runs ar SET workspace_id = d.workspace_id
  FROM automations a JOIN databases d ON d.id = a.database_id
  WHERE ar.automation_id = a.id;--> statement-breakpoint
ALTER TABLE "automation_runs" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_runs_workspace_idx" ON "automation_runs" USING btree ("workspace_id","created_at");