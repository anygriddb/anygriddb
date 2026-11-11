-- Erasing an account keeps the audit fact and drops the person: the
-- row's author becomes one shared tombstone, and nothing else in the row
-- may change. The flag is local to that transaction.
CREATE OR REPLACE FUNCTION prevent_audit_tampering()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
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
$$;--> statement-breakpoint

INSERT INTO "users" ("id", "email", "display_name", "is_admin", "disabled_at")
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'erased@users.invalid',
  'Erased account',
  false,
  now()
)
ON CONFLICT ("id") DO NOTHING;
