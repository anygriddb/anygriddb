-- The security policy an administrator sets (ADR 0043): locked accounts,
-- password resets, and what the sign-in trail now records.
ALTER TYPE "public"."auth_action" ADD VALUE 'account_locked';--> statement-breakpoint
ALTER TYPE "public"."auth_action" ADD VALUE 'account_unlocked';--> statement-breakpoint
ALTER TYPE "public"."auth_action" ADD VALUE 'password_changed';--> statement-breakpoint
ALTER TYPE "public"."auth_action" ADD VALUE 'password_reset_requested';--> statement-breakpoint
ALTER TYPE "public"."auth_action" ADD VALUE 'password_reset';--> statement-breakpoint
ALTER TYPE "public"."auth_action" ADD VALUE 'settings_changed';--> statement-breakpoint

-- Failed passwords and codes in a row; a success sets it back to 0. The
-- lock lasts as long as the policy says, from locked_at.
ALTER TABLE "users"
  ADD COLUMN "failed_sign_ins" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "locked_at" timestamp with time zone,
  ADD CONSTRAINT "users_failed_sign_ins_check" CHECK ("failed_sign_ins" >= 0);--> statement-breakpoint

-- A link that sets a new password, once. Only its hash is kept.
CREATE TABLE "password_resets" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL UNIQUE,
  -- The administrator who sent it; null when the person asked for it.
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX "password_resets_user" ON "password_resets" ("user_id");--> statement-breakpoint

-- The trail may now be kept six months to a year, as the instance says:
-- the purge may delete events past six months, never more recent ones.
CREATE OR REPLACE FUNCTION "auth_events_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.occurred_at < now() - interval '180 days' THEN
      RETURN OLD;
    END IF;
  ELSIF NEW.id = OLD.id
    AND NEW.occurred_at = OLD.occurred_at
    AND NEW.action = OLD.action
    AND NEW.method IS NOT DISTINCT FROM OLD.method
    AND NEW.detail IS NOT DISTINCT FROM OLD.detail
    AND (NEW.user_id IS NULL OR NEW.user_id = OLD.user_id)
    AND (NEW.actor_id IS NULL OR NEW.actor_id = OLD.actor_id)
    AND (NEW.ip IS NULL OR NEW.ip = OLD.ip) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Auth events are append-only';
END;
$$;
