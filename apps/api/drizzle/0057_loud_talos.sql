CREATE TABLE "github_review_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"comment_id" text NOT NULL,
	"in_reply_to_id" text,
	"path" text,
	"line" integer,
	"side" text,
	"diff_hunk" text,
	"author_login" text,
	"body" text NOT NULL,
	"reactions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"github_created_at" timestamp with time zone,
	"github_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_review_comments" ADD CONSTRAINT "github_review_comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_review_comments_workspace_comment_uq" ON "github_review_comments" USING btree ("workspace_id","comment_id");--> statement-breakpoint
CREATE INDEX "github_review_comments_pr_idx" ON "github_review_comments" USING btree ("workspace_id","repo","pr_number");