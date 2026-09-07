CREATE TYPE "public"."portal_access_outcome" AS ENUM('served', 'rejected');--> statement-breakpoint
CREATE TABLE "portal_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"view_id" uuid NOT NULL,
	"outcome" "portal_access_outcome" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_access_log" ADD CONSTRAINT "portal_access_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_access_log" ADD CONSTRAINT "portal_access_log_recipient_id_portal_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."portal_recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_access_log_recipient_idx" ON "portal_access_log" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "portal_access_log_view_idx" ON "portal_access_log" USING btree ("view_id","created_at");--> statement-breakpoint
CREATE INDEX "portal_access_log_workspace_idx" ON "portal_access_log" USING btree ("workspace_id","created_at");