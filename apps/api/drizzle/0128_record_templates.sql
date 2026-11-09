ALTER TYPE "public"."pack_install_item_kind" ADD VALUE 'record_template';--> statement-breakpoint
CREATE TABLE "record_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text,
	"origin" text DEFAULT 'user' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "record_templates" ADD CONSTRAINT "record_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_templates" ADD CONSTRAINT "record_templates_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "record_templates_database_idx" ON "record_templates" USING btree ("database_id");