CREATE TYPE "public"."pack_install_item_action" AS ENUM('created', 'reused');--> statement-breakpoint
CREATE TYPE "public"."pack_install_item_kind" AS ENUM('database', 'field', 'relation', 'state', 'agent', 'trigger', 'derived_field', 'view', 'automation', 'sample_record', 'skill');--> statement-breakpoint
CREATE TABLE "pack_install_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_install_id" uuid NOT NULL,
	"kind" "pack_install_item_kind" NOT NULL,
	"name" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" "pack_install_item_action" NOT NULL,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pack_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"installed_by" text NOT NULL,
	"uninstalled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pack_install_items" ADD CONSTRAINT "pack_install_items_pack_install_id_pack_installs_id_fk" FOREIGN KEY ("pack_install_id") REFERENCES "public"."pack_installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_installs" ADD CONSTRAINT "pack_installs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pack_install_items_install_idx" ON "pack_install_items" USING btree ("pack_install_id");--> statement-breakpoint
CREATE INDEX "pack_install_items_entity_idx" ON "pack_install_items" USING btree ("kind","entity_id");--> statement-breakpoint
CREATE INDEX "pack_installs_workspace_slug_idx" ON "pack_installs" USING btree ("workspace_id","slug");