ALTER TABLE "databases" ADD COLUMN "restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "restricted" boolean DEFAULT false NOT NULL;