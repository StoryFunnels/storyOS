ALTER TABLE "activity_events" ADD COLUMN "token_id" uuid;--> statement-breakpoint
ALTER TABLE "record_field_changes" ADD COLUMN "token_id" uuid;--> statement-breakpoint
ALTER TABLE "record_versions" ADD COLUMN "token_id" uuid;--> statement-breakpoint
CREATE INDEX "activity_token_created_idx" ON "activity_events" USING btree ("token_id","created_at");