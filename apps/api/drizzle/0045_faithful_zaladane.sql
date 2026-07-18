CREATE TYPE "public"."entitlement_override_event_action" AS ENUM('set', 'clear');--> statement-breakpoint
CREATE TABLE "entitlement_override_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" "entitlement_override_event_action" NOT NULL,
	"snapshot" jsonb NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_entitlement_overrides" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"included_seats" integer,
	"automation_runs_per_month" integer,
	"max_workspaces" integer,
	"feature_flags" jsonb,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entitlement_override_events" ADD CONSTRAINT "entitlement_override_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_entitlement_overrides" ADD CONSTRAINT "workspace_entitlement_overrides_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entitlement_override_events_workspace_idx" ON "entitlement_override_events" USING btree ("workspace_id","created_at");