CREATE TABLE "referral_codes" (
	"user_id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "referral_reward_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signup_id" uuid NOT NULL,
	"referrer_user_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"referrer_user_id" text NOT NULL,
	"referee_user_id" text NOT NULL,
	"converted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "referral_reward_grants" ADD CONSTRAINT "referral_reward_grants_signup_id_referral_signups_id_fk" FOREIGN KEY ("signup_id") REFERENCES "public"."referral_signups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "referral_reward_grants_referrer_idx" ON "referral_reward_grants" USING btree ("referrer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_signups_referee_uq" ON "referral_signups" USING btree ("referee_user_id");--> statement-breakpoint
CREATE INDEX "referral_signups_referrer_idx" ON "referral_signups" USING btree ("referrer_user_id");