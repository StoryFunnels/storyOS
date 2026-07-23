CREATE TYPE "public"."pack_listing_vertical" AS ENUM('sales', 'marketing', 'support', 'engineering', 'hr', 'finance', 'agency', 'ops', 'other');--> statement-breakpoint
CREATE TYPE "public"."pack_submission_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "pack_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"submitted_by" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"vertical" "pack_listing_vertical" NOT NULL,
	"screenshots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manifest" jsonb NOT NULL,
	"status" "pack_submission_status" DEFAULT 'pending' NOT NULL,
	"review_notes" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_pack_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"published_pack_id" uuid NOT NULL,
	"submission_id" uuid,
	"version" text NOT NULL,
	"changelog" text,
	"manifest" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"vertical" "pack_listing_vertical" NOT NULL,
	"license" text NOT NULL,
	"attribution" text,
	"screenshots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latest_version" text NOT NULL,
	"submitted_by_workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pack_submissions" ADD CONSTRAINT "pack_submissions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_pack_versions" ADD CONSTRAINT "published_pack_versions_published_pack_id_published_packs_id_fk" FOREIGN KEY ("published_pack_id") REFERENCES "public"."published_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_pack_versions" ADD CONSTRAINT "published_pack_versions_submission_id_pack_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."pack_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_packs" ADD CONSTRAINT "published_packs_submitted_by_workspace_id_workspaces_id_fk" FOREIGN KEY ("submitted_by_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pack_submissions_status_idx" ON "pack_submissions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "pack_submissions_workspace_idx" ON "pack_submissions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "published_pack_versions_pack_idx" ON "published_pack_versions" USING btree ("published_pack_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "published_packs_slug_idx" ON "published_packs" USING btree ("slug");