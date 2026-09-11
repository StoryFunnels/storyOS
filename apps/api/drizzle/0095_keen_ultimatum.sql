CREATE TABLE "bulk_record_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"source" text DEFAULT 'human' NOT NULL,
	"op" text NOT NULL,
	"record_ids" jsonb NOT NULL,
	"values" jsonb,
	"cursor" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"restorable" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bulk_record_jobs" ADD CONSTRAINT "bulk_record_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_record_jobs" ADD CONSTRAINT "bulk_record_jobs_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bulk_record_jobs_claim_idx" ON "bulk_record_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bulk_record_jobs_database_idx" ON "bulk_record_jobs" USING btree ("database_id");