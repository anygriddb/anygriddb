-- An administrator may act with another person's rights for half an hour
-- (ADR 0091). The session stays theirs. The change trail keeps both:
-- the author is the administrator, and this column is the person.
ALTER TABLE "sessions" ADD COLUMN "impersonated_user_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "impersonate_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonated_user_id_users_id_fk" FOREIGN KEY ("impersonated_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
CREATE INDEX "sessions_impersonated_user" ON "sessions" ("impersonated_user_id") WHERE "impersonated_user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "impersonated_user_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_impersonated_user_id_users_id_fk" FOREIGN KEY ("impersonated_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TYPE "public"."auth_action" ADD VALUE IF NOT EXISTS 'acting_as_started';--> statement-breakpoint
ALTER TYPE "public"."auth_action" ADD VALUE IF NOT EXISTS 'acting_as_ended';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE IF NOT EXISTS 'acting_as';--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_events_note_acting()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.impersonated_user_id IS NULL THEN
    BEGIN
      NEW.impersonated_user_id := nullif(current_setting('anygrid.impersonated_user_id', true), '')::uuid;
    EXCEPTION
      WHEN invalid_text_representation THEN
        NEW.impersonated_user_id := NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_events_note_acting
  BEFORE INSERT ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION audit_events_note_acting();--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_audit_tampering()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND TG_TABLE_NAME = 'audit_events'
    AND current_setting('anygrid.purge_audit', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND current_setting('anygrid.anonymize', true) = 'on' THEN
    IF TG_TABLE_NAME = 'row_signatures'
      AND to_jsonb(NEW) - 'user_id' - 'display_name'
        = to_jsonb(OLD) - 'user_id' - 'display_name' THEN
      RETURN NEW;
    END IF;
    IF TG_TABLE_NAME <> 'row_signatures'
      AND to_jsonb(NEW) - 'user_id' - 'impersonated_user_id'
        = to_jsonb(OLD) - 'user_id' - 'impersonated_user_id' THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Audit immutable';
END;
$$;
