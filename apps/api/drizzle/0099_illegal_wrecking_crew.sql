ALTER TABLE "comments" ADD COLUMN "source" "change_source";--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "agent_name" text;