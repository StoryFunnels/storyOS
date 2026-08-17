CREATE TYPE "public"."change_source" AS ENUM('human', 'agent', 'automation', 'mcp');--> statement-breakpoint
CREATE TABLE "record_field_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"field_id" uuid,
	"actor_user_id" text,
	"source" "change_source" DEFAULT 'human' NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "record_field_changes" ADD CONSTRAINT "record_field_changes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_field_changes" ADD CONSTRAINT "record_field_changes_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_field_changes" ADD CONSTRAINT "record_field_changes_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "record_field_changes_record_created_idx" ON "record_field_changes" USING btree ("record_id","created_at");--> statement-breakpoint
CREATE INDEX "record_field_changes_db_field_created_idx" ON "record_field_changes" USING btree ("database_id","field_id","created_at");--> statement-breakpoint
CREATE INDEX "record_field_changes_ws_created_idx" ON "record_field_changes" USING btree ("workspace_id","created_at");