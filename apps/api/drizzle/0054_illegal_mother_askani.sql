CREATE TYPE "public"."skill_visibility" AS ENUM('personal', 'shared');--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"visibility" "skill_visibility" DEFAULT 'personal' NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"when_to_use" text NOT NULL,
	"instructions" text NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_template" text,
	"last_run_at" timestamp with time zone,
	"last_run_status" text,
	"last_run_steps" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skills_workspace_visibility_idx" ON "skills" USING btree ("workspace_id","visibility");--> statement-breakpoint
CREATE INDEX "skills_owner_idx" ON "skills" USING btree ("workspace_id","owner_id");