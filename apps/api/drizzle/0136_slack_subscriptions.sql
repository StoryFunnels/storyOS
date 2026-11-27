CREATE TABLE "slack_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"space_id" uuid,
	"database_id" uuid,
	"channel" text,
	"events" text[] NOT NULL,
	"created_by" text NOT NULL,
	"needs_attention" text,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_subscriptions_scope_xor" CHECK (("slack_subscriptions"."database_id" IS NULL) <> ("slack_subscriptions"."space_id" IS NULL)),
	CONSTRAINT "slack_subscriptions_events_valid" CHECK (cardinality("slack_subscriptions"."events") >= 1 AND "slack_subscriptions"."events" <@ ARRAY['created', 'status_changed', 'commented']::text[])
);
--> statement-breakpoint
ALTER TABLE "slack_subscriptions" ADD CONSTRAINT "slack_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_subscriptions" ADD CONSTRAINT "slack_subscriptions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_subscriptions" ADD CONSTRAINT "slack_subscriptions_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_subscriptions_workspace_idx" ON "slack_subscriptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "slack_subscriptions_space_idx" ON "slack_subscriptions" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "slack_subscriptions_database_idx" ON "slack_subscriptions" USING btree ("database_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_subscriptions_database_channel_uq" ON "slack_subscriptions" USING btree ("database_id",coalesce("channel", '')) WHERE "slack_subscriptions"."database_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_subscriptions_space_channel_uq" ON "slack_subscriptions" USING btree ("space_id",coalesce("channel", '')) WHERE "slack_subscriptions"."space_id" IS NOT NULL;