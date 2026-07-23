CREATE TABLE "calendar_event_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"external_event_id" text NOT NULL,
	"external_updated_at" timestamp with time zone,
	"content_hash" text,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_sync_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"calendar_id" text NOT NULL,
	"calendar_name" text NOT NULL,
	"start_field_id" uuid NOT NULL,
	"end_field_id" uuid,
	"description_field_id" uuid,
	"direction" text DEFAULT 'push' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_binding_id_calendar_sync_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."calendar_sync_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_bindings" ADD CONSTRAINT "calendar_sync_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_bindings" ADD CONSTRAINT "calendar_sync_bindings_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_bindings" ADD CONSTRAINT "calendar_sync_bindings_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_bindings" ADD CONSTRAINT "calendar_sync_bindings_start_field_id_fields_id_fk" FOREIGN KEY ("start_field_id") REFERENCES "public"."fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_bindings" ADD CONSTRAINT "calendar_sync_bindings_end_field_id_fields_id_fk" FOREIGN KEY ("end_field_id") REFERENCES "public"."fields"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_bindings" ADD CONSTRAINT "calendar_sync_bindings_description_field_id_fields_id_fk" FOREIGN KEY ("description_field_id") REFERENCES "public"."fields"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_links_binding_record_uq" ON "calendar_event_links" USING btree ("binding_id","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_links_binding_external_uq" ON "calendar_event_links" USING btree ("binding_id","external_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_sync_bindings_database_calendar_uq" ON "calendar_sync_bindings" USING btree ("database_id","calendar_id");--> statement-breakpoint
CREATE INDEX "calendar_sync_bindings_workspace_idx" ON "calendar_sync_bindings" USING btree ("workspace_id");