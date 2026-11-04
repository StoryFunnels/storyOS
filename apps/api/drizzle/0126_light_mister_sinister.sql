CREATE TABLE "agent_budget_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"period" text NOT NULL,
	"metric" text NOT NULL,
	"level" text NOT NULL,
	"limit_value" bigint NOT NULL,
	"notified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_budget_notices" ADD CONSTRAINT "agent_budget_notices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_budget_notices_uq" ON "agent_budget_notices" USING btree ("agent_id","period","metric","level","limit_value");