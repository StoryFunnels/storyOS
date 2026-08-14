ALTER TABLE "databases" ADD COLUMN "description_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "description_order" integer;