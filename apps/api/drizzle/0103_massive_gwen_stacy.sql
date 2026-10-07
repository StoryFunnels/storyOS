ALTER TABLE "billing_subscriptions" ADD COLUMN "subscription_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
-- #817: a subscription that is ALREADY paying predates this event. Mark it started so its next
-- renewal does not emit `subscription_started` and read as a new customer. Only workspaces that
-- first become paying AFTER this ships should be in the funnel. (workspaces.activated_at is left
-- NULL on purpose: backfilling it would need the activation definition copied into SQL, a second
-- definition of one concept; the event's `workspace_age_days` separates the historical ones.)
UPDATE "billing_subscriptions" SET "subscription_started_at" = now() WHERE "status" = 'active';
