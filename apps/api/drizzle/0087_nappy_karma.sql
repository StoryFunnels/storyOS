ALTER TABLE "activity_events" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_events" ADD COLUMN "agent_name" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "record_field_changes" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "record_field_changes" ADD COLUMN "agent_name" text;--> statement-breakpoint
CREATE INDEX "activity_agent_created_idx" ON "activity_events" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "record_field_changes_agent_created_idx" ON "record_field_changes" USING btree ("agent_id","created_at");