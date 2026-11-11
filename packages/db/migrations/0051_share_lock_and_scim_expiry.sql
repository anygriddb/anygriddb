-- A public link's password has its own failure count, independent of the
-- client address. Ten wrong passwords lock it for fifteen minutes.
ALTER TABLE "shares"
  ADD COLUMN "password_failures" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "password_locked_until" timestamp with time zone,
  ADD CONSTRAINT "shares_password_failures_check"
    CHECK ("password_failures" >= 0 AND "password_failures" < 10);--> statement-breakpoint

-- A SCIM token expires. Existing tokens keep a year from when they were made.
ALTER TABLE "scim_tokens"
  ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "scim_tokens"
  SET "expires_at" = "created_at" + interval '365 days'
  WHERE "expires_at" IS NULL;--> statement-breakpoint
ALTER TABLE "scim_tokens"
  ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint

-- New webhooks omit row values unless the person asks for them.
ALTER TABLE "webhooks" ALTER COLUMN "include_values" SET DEFAULT false;
