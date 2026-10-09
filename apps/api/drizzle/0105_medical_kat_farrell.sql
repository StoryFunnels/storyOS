ALTER TYPE "public"."skill_visibility" ADD VALUE 'members' BEFORE 'shared';--> statement-breakpoint
ALTER TYPE "public"."skill_visibility" ADD VALUE 'public';--> statement-breakpoint
CREATE TABLE "skill_members" (
	"skill_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_members_skill_id_user_id_pk" PRIMARY KEY("skill_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "version" text DEFAULT '1.0.0' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "public_token" text;--> statement-breakpoint
ALTER TABLE "skill_members" ADD CONSTRAINT "skill_members_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_members_user_idx" ON "skill_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_public_token_uq" ON "skills" USING btree ("public_token") WHERE "skills"."public_token" IS NOT NULL;