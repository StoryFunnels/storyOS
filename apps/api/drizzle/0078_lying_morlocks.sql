ALTER TYPE "public"."field_type" ADD VALUE 'attachment' BEFORE 'relation';--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "field_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_field_id_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."fields"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_record_field_idx" ON "attachments" USING btree ("record_id","field_id");