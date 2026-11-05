CREATE TABLE "oauth_state_uses" (
	"nonce" text PRIMARY KEY NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
