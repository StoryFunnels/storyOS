ALTER TABLE "workspaces" ADD COLUMN "onboarding_nudge_guest_invited_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "onboarding_nudge_second_database_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "onboarding_nudge_form_published_sent_at" timestamp with time zone;