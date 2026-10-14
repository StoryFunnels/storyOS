CREATE TABLE "linear_comment_pushes" (
	"comment_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"linear_issue_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"linear_comment_id" text,
	"linear_comment_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "linear_comment_pushes" ADD CONSTRAINT "linear_comment_pushes_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_comment_pushes" ADD CONSTRAINT "linear_comment_pushes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "linear_comment_pushes_due_idx" ON "linear_comment_pushes" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "linear_comment_pushes_linear_comment_idx" ON "linear_comment_pushes" USING btree ("linear_comment_id");