ALTER TABLE "activity_events" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_events" ADD COLUMN "runner_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_events" ADD COLUMN "runner_name" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "runner_id" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "wake_id" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "run_depth" integer;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "runner_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "runner_name" text;--> statement-breakpoint
ALTER TABLE "record_field_changes" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "record_field_changes" ADD COLUMN "runner_id" uuid;--> statement-breakpoint
ALTER TABLE "record_field_changes" ADD COLUMN "runner_name" text;--> statement-breakpoint
ALTER TABLE "record_versions" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "record_versions" ADD COLUMN "runner_id" uuid;--> statement-breakpoint
ALTER TABLE "record_versions" ADD COLUMN "runner_name" text;