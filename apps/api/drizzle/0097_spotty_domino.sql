ALTER TABLE "record_versions" ADD COLUMN "source" "change_source" DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "record_versions" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "record_versions" ADD COLUMN "agent_name" text;