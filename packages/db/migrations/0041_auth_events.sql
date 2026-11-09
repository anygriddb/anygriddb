-- The sign-in trail administrators read (Administration > Audit > Sign-ins):
-- sign-ins, failures, sign-outs, and what an administrator did to an
-- account. Apart from audit_events (row and catalog writes): a failed
-- password has no account, and this trail must not mix with row history.
CREATE TYPE "public"."auth_action" AS ENUM(
  'login_success',
  'login_failure',
  'logout',
  'session_revoked',
  'factors_cleared',
  'tokens_revoked'
);--> statement-breakpoint
CREATE TABLE "auth_events" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "action" "auth_action" NOT NULL,
  -- The account concerned, when known. Never an email.
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  -- The administrator who acted on it; null when the person acted.
  "actor_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "method" text,
  "detail" text,
  -- The client address Fastify resolved (trustProxy), kept a year.
  "ip" text
);--> statement-breakpoint
CREATE INDEX "auth_events_occurred_at" ON "auth_events" ("occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "auth_events_user" ON "auth_events" ("user_id", "occurred_at" DESC)
  WHERE "user_id" IS NOT NULL;--> statement-breakpoint

-- Append-only, with two exceptions: an event older than a year may be
-- deleted (the retention purge), and erasing an account may clear the ids
-- and the address that point to it, and nothing else.
CREATE FUNCTION "auth_events_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.occurred_at < now() - interval '1 year' THEN
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
$$;--> statement-breakpoint
CREATE TRIGGER "auth_events_append_only"
  BEFORE UPDATE OR DELETE ON "auth_events"
  FOR EACH ROW EXECUTE FUNCTION "auth_events_guard"();
