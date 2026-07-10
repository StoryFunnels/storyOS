ALTER TYPE "public"."field_type" ADD VALUE 'id' BEFORE 'title';--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "record_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "number" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "records_db_number_uq" ON "records" USING btree ("database_id","number");