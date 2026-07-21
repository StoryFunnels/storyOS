ALTER TABLE "ai_credit_balances" ADD COLUMN "auto_reload_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_credit_balances" ADD COLUMN "auto_reload_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_credit_balances" ADD COLUMN "auto_reload_next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_credit_transactions" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_credit_transactions" ADD COLUMN "remaining_cents" integer;