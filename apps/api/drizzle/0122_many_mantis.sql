CREATE TABLE "agent_wakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"record_id" uuid,
	"database_id" uuid,
	"reason" text NOT NULL,
	"requested_by" text,
	"source_key" text,
	"depth" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"runner_id" uuid,
	"claim_nonce" text,
	"lease_expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"rewake" boolean DEFAULT false NOT NULL,
	"rewake_requested_by" text,
	"rewake_depth" integer,
	"rewake_reason" text,
	"run_id" uuid,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context" jsonb,
	"coalesced_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_wakes" ADD CONSTRAINT "agent_wakes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_wakes" ADD CONSTRAINT "agent_wakes_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_wakes_open_record_uq" ON "agent_wakes" USING btree ("agent_id","record_id") WHERE "agent_wakes"."record_id" IS NOT NULL AND "agent_wakes"."status" IN ('queued', 'claimed');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_wakes_open_norecord_uq" ON "agent_wakes" USING btree ("agent_id") WHERE "agent_wakes"."record_id" IS NULL AND "agent_wakes"."status" IN ('queued', 'claimed');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_wakes_source_key_uq" ON "agent_wakes" USING btree ("source_key") WHERE "agent_wakes"."source_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_wakes_claim_idx" ON "agent_wakes" USING btree ("workspace_id","status","not_before");--> statement-breakpoint
CREATE INDEX "agent_wakes_runner_idx" ON "agent_wakes" USING btree ("runner_id","status");--> statement-breakpoint
CREATE INDEX "agent_wakes_lease_idx" ON "agent_wakes" USING btree ("status","lease_expires_at");