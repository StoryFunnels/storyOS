ALTER TABLE "views" ALTER COLUMN "database_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "space_id" uuid;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_folder_id_space_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."space_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "views_space_idx" ON "views" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "views_folder_idx" ON "views" USING btree ("folder_id");--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_owner_xor" CHECK (("views"."database_id" IS NULL) <> ("views"."space_id" IS NULL));