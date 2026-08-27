ALTER TABLE "api_tokens" ADD COLUMN "origin" "change_source";--> statement-breakpoint
ALTER TABLE "tyron_messages" ADD COLUMN "tokens_in" integer;--> statement-breakpoint
ALTER TABLE "tyron_messages" ADD COLUMN "tokens_out" integer;--> statement-breakpoint
ALTER TABLE "tyron_messages" ADD COLUMN "model" text;