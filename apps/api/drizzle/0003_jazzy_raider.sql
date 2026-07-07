CREATE TABLE "records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"database_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" text DEFAULT 'a0' NOT NULL,
	"created_by" text,
	"updated_by" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "records_values_gin" ON "records" USING gin ("values" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "records_db_position_idx" ON "records" USING btree ("database_id","position");--> statement-breakpoint
CREATE INDEX "records_db_created_idx" ON "records" USING btree ("database_id","created_at","id");--> statement-breakpoint
CREATE INDEX "records_title_trgm" ON "records" USING gin ("title" gin_trgm_ops);