-- A code mailed to the account's address as its second factor (ADR 0085):
-- the accounts that chose it, and the one code an account has at a time
-- for a purpose, kept as an HMAC, with the guesses made at it and the
-- sends that bound what a mailbox receives. Both leave with the account.
CREATE TYPE "public"."email_otp_purpose" AS ENUM('enroll', 'login');--> statement-breakpoint
CREATE TABLE "email_factors" (
	"user_id" uuid PRIMARY KEY NOT NULL
		REFERENCES "public"."users" ("id") ON DELETE CASCADE,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "email_otp_codes" (
	"user_id" uuid NOT NULL
		REFERENCES "public"."users" ("id") ON DELETE CASCADE,
	"purpose" "public"."email_otp_purpose" NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"send_count" integer DEFAULT 1 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_otp_codes_pkey" PRIMARY KEY ("user_id", "purpose")
);
