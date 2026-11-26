ALTER TYPE "public"."change_source" ADD VALUE 'import';--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "identifier_prefix" text;--> statement-breakpoint
CREATE UNIQUE INDEX "databases_workspace_identifier_prefix_uq" ON "databases" USING btree ("workspace_id",lower("identifier_prefix")) WHERE "databases"."identifier_prefix" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_identifier_prefix_valid" CHECK ("databases"."identifier_prefix" IS NULL OR "databases"."identifier_prefix" ~ '^[A-Z][A-Z0-9]{1,9}$');