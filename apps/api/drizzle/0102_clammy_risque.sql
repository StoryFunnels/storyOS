ALTER TABLE "workspaces" ADD COLUMN "sales_signal_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "sales_signal_reason" text;