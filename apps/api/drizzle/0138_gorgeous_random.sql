CREATE INDEX "document_versions_created_idx" ON "document_versions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "record_field_changes_created_idx" ON "record_field_changes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "record_versions_created_idx" ON "record_versions" USING btree ("created_at");