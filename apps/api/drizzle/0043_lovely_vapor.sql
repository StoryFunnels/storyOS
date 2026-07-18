CREATE TYPE "public"."ai_credit_transaction_type" AS ENUM('top_up', 'usage', 'refund', 'adjustment');--> statement-breakpoint
CREATE TABLE "ai_credit_balances" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"balance_cents" integer DEFAULT 0 NOT NULL,
	"auto_reload_enabled" boolean DEFAULT false NOT NULL,
	"auto_reload_threshold_cents" integer,
	"auto_reload_amount_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "ai_credit_transaction_type" NOT NULL,
	"amount_cents" integer NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"our_cost_cents" integer,
	"stripe_payment_intent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_credit_transactions_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id")
);
--> statement-breakpoint
ALTER TABLE "ai_credit_balances" ADD CONSTRAINT "ai_credit_balances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_credit_transactions" ADD CONSTRAINT "ai_credit_transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_credit_transactions_workspace_idx" ON "ai_credit_transactions" USING btree ("workspace_id","created_at");