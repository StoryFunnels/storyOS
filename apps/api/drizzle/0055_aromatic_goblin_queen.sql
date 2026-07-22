CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"rule_id" uuid,
	"run_id" uuid,
	"record_id" uuid,
	"action_index" integer NOT NULL,
	"action_snapshot" jsonb NOT NULL,
	"preview_text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approver_id" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reason" text,
	"expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_jobs" ADD COLUMN "approval_id" uuid;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "approver_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "ref_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_rule_id_automations_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_workspace_status_expiry_idx" ON "approvals" USING btree ("workspace_id","status","expires_at");--> statement-breakpoint
ALTER TABLE "automation_jobs" ADD CONSTRAINT "automation_jobs_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;