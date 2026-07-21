CREATE TYPE "public"."connection_status" AS ENUM('active', 'expired', 'revoked', 'error');--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"auth_sealed" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"last_ok_at" timestamp with time zone,
	"error_streak" integer DEFAULT 0 NOT NULL,
	"breaker_open_until" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_workspace_provider_idx" ON "connections" USING btree ("workspace_id","provider");