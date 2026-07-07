CREATE TYPE "public"."relation_cardinality" AS ENUM('one_to_many', 'many_to_many');--> statement-breakpoint
CREATE TABLE "record_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relation_id" uuid NOT NULL,
	"from_record_id" uuid NOT NULL,
	"to_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"database_a_id" uuid NOT NULL,
	"database_b_id" uuid NOT NULL,
	"field_a_id" uuid NOT NULL,
	"field_b_id" uuid NOT NULL,
	"cardinality" "relation_cardinality" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "record_links" ADD CONSTRAINT "record_links_relation_id_relations_id_fk" FOREIGN KEY ("relation_id") REFERENCES "public"."relations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_links" ADD CONSTRAINT "record_links_from_record_id_records_id_fk" FOREIGN KEY ("from_record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_links" ADD CONSTRAINT "record_links_to_record_id_records_id_fk" FOREIGN KEY ("to_record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_database_a_id_databases_id_fk" FOREIGN KEY ("database_a_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_database_b_id_databases_id_fk" FOREIGN KEY ("database_b_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "record_links_uq" ON "record_links" USING btree ("relation_id","from_record_id","to_record_id");--> statement-breakpoint
CREATE INDEX "record_links_from_idx" ON "record_links" USING btree ("relation_id","from_record_id");--> statement-breakpoint
CREATE INDEX "record_links_to_idx" ON "record_links" USING btree ("relation_id","to_record_id");