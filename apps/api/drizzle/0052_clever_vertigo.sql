ALTER TABLE "automations" ADD COLUMN "hook_token" text;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "hook_secret" text;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "last_hook_payload" jsonb;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "last_hook_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_hook_token_unique" UNIQUE("hook_token");