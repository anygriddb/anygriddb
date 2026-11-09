-- More of the policy an administrator sets (ADR 0044): inactive accounts
-- disabled, and administrators told when an account locks.
ALTER TYPE "public"."auth_action" ADD VALUE 'account_disabled';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'account_locked';--> statement-breakpoint

-- When the account was last active: a sign-in, a token used, or an
-- administrator enabling it again. The warning before it is disabled is
-- sent once, until it is active again.
ALTER TABLE "users"
  ADD COLUMN "active_at" timestamp with time zone DEFAULT now() NOT NULL,
  ADD COLUMN "inactivity_warned_at" timestamp with time zone,
  -- Why it is disabled: by an administrator, or after a time without
  -- activity. Null while it is enabled, or when an identity provider
  -- (SCIM) disabled it.
  ADD COLUMN "disabled_reason" text,
  ADD CONSTRAINT "users_disabled_reason_check"
    CHECK ("disabled_reason" IN ('admin', 'inactive'));--> statement-breakpoint

-- Today's accounts: the latest of their creation, sign-ins, and tokens.
UPDATE "users" AS u SET "active_at" = GREATEST(
  u."created_at",
  COALESCE((SELECT max(s."created_at") FROM "sessions" s WHERE s."user_id" = u."id"), u."created_at"),
  COALESCE((SELECT max(e."occurred_at") FROM "auth_events" e
    WHERE e."user_id" = u."id" AND e."action" = 'login_success'), u."created_at"),
  COALESCE((SELECT max(k."last_used_at") FROM "api_tokens" k WHERE k."user_id" = u."id"), u."created_at")
);--> statement-breakpoint
-- Disabled by an administrator; an identity provider's (SCIM) say nothing.
UPDATE "users" SET "disabled_reason" = 'admin'
  WHERE "disabled_at" IS NOT NULL AND "scim_user_name" IS NULL;
