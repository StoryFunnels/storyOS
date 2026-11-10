CREATE TABLE IF NOT EXISTS "my_work_digest_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_key" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slot" timestamp with time zone NOT NULL,
	"outcome" text DEFAULT 'claimed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "my_work_digest_sends" ADD CONSTRAINT "my_work_digest_sends_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "my_work_digest_sends_source_key_uq" ON "my_work_digest_sends" USING btree ("source_key");