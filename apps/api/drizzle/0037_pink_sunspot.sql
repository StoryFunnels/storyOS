CREATE TABLE "record_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"target_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "record_mentions" ADD CONSTRAINT "record_mentions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_mentions" ADD CONSTRAINT "record_mentions_source_record_id_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_mentions" ADD CONSTRAINT "record_mentions_target_record_id_records_id_fk" FOREIGN KEY ("target_record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "record_mentions_uq" ON "record_mentions" USING btree ("source_record_id","target_record_id");--> statement-breakpoint
CREATE INDEX "record_mentions_target_idx" ON "record_mentions" USING btree ("target_record_id");