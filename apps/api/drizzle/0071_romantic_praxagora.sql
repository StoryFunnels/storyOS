ALTER TABLE "spaces" ADD COLUMN "personal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_workspace_owner_uq" ON "spaces" USING btree ("workspace_id","owner_user_id") WHERE "spaces"."personal";