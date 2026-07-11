CREATE TABLE "space_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "space_documents" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "space_folders" ADD CONSTRAINT "space_folders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_folders" ADD CONSTRAINT "space_folders_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_folder_id_space_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."space_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_documents" ADD CONSTRAINT "space_documents_folder_id_space_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."space_folders"("id") ON DELETE set null ON UPDATE no action;