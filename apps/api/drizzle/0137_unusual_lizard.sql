CREATE TABLE "linear_status_pushes" (
	"record_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_key" text NOT NULL,
	"linear_issue_id" text NOT NULL,
	"target_label" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"applied_label" text,
	"applied_state_id" text,
	"applied_generation" integer,
	"change_source" text,
	"change_agent_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "linear_status_pushes" ADD CONSTRAINT "linear_status_pushes_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_status_pushes" ADD CONSTRAINT "linear_status_pushes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "linear_status_pushes_due_idx" ON "linear_status_pushes" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "linear_status_pushes_ws_team_idx" ON "linear_status_pushes" USING btree ("workspace_id","team_key","status");