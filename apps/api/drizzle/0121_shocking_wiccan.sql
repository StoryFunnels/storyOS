CREATE TYPE "public"."runner_status" AS ENUM('pending', 'active', 'revoked');--> statement-breakpoint
CREATE TABLE "runner_agents" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"assigned_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_pairing_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "runner_pairing_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"pairing_code_id" uuid,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"status" "runner_status" DEFAULT 'pending' NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chosen_tool" text,
	"runner_version" text,
	"protocol_version" integer,
	"last_seen_at" timestamp with time zone,
	"offline_notified_at" timestamp with time zone,
	"paused_until" timestamp with time zone,
	"pause_reason" text,
	"pending_expires_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runners_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "runner_agents" ADD CONSTRAINT "runner_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_agents" ADD CONSTRAINT "runner_agents_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_pairing_codes" ADD CONSTRAINT "runner_pairing_codes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_pairing_code_id_runner_pairing_codes_id_fk" FOREIGN KEY ("pairing_code_id") REFERENCES "public"."runner_pairing_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runner_agents_runner_idx" ON "runner_agents" USING btree ("runner_id");--> statement-breakpoint
CREATE INDEX "runner_pairing_codes_user_idx" ON "runner_pairing_codes" USING btree ("workspace_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "runner_pairing_failures_ip_idx" ON "runner_pairing_failures" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "runner_pairing_failures_created_idx" ON "runner_pairing_failures" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "runners_owner_idx" ON "runners" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "runners_status_idx" ON "runners" USING btree ("status","last_seen_at");