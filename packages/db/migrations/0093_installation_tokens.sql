-- The first account of an instance administers it. It is made with a
-- token the operator asks for from the command line (ADR 0080): only the
-- token's hash is kept, with when it stops working and when it was used.
CREATE TABLE "installation_tokens" (
	"id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installation_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TYPE "public"."auth_action" ADD VALUE IF NOT EXISTS 'install_token_issued';--> statement-breakpoint
ALTER TYPE "public"."auth_action" ADD VALUE IF NOT EXISTS 'install_token_used';
