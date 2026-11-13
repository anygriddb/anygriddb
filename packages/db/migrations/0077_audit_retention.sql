-- The change trail kept for a time an administrator chooses (ADR 0069).
-- It stays append-only for every write: only its own purge deletes, and
-- only from `audit_events`, behind a flag local to its transaction.
-- Signatures and the trails of client tables are never deleted.
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'purge';--> statement-breakpoint
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
    -- Only the person may change: the author, and a signature's displayed name.
    IF TG_TABLE_NAME = 'row_signatures'
      AND to_jsonb(NEW) - 'user_id' - 'display_name'
        = to_jsonb(OLD) - 'user_id' - 'display_name' THEN
      RETURN NEW;
    END IF;
    IF TG_TABLE_NAME <> 'row_signatures'
      AND to_jsonb(NEW) - 'user_id' = to_jsonb(OLD) - 'user_id' THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Audit immutable';
END;
$$;
