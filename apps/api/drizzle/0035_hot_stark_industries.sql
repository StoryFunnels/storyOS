CREATE TYPE "public"."token_scope" AS ENUM('read', 'write', 'admin');--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "scope" "token_scope" DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "allow_run_button" boolean DEFAULT true NOT NULL;