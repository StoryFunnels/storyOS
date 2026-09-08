DROP INDEX "portal_recipients_token_uq";--> statement-breakpoint
ALTER TABLE "portal_recipients" ADD COLUMN "token_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "portal_recipients" ADD COLUMN "expires_at" timestamp with time zone;