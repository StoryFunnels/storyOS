ALTER TABLE "automation_runs" ADD COLUMN "selection_rank" integer;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "sort" jsonb;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "top_n_limit" integer;