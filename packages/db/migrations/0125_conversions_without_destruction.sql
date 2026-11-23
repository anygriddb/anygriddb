-- A field's conversion can run in the background.
ALTER TYPE "public"."job_kind" ADD VALUE IF NOT EXISTS 'convert_column';--> statement-breakpoint

-- What a value becomes in another type is now read by the cell's own rule,
-- in the server: these three no longer have a caller.
DROP FUNCTION IF EXISTS ag_try_numeric(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS ag_try_date(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS ag_try_timestamptz(text);--> statement-breakpoint

-- A table is read-only while a job converts one of its fields. Only the
-- job's own statements pass; once the job has ended, however it ended, the
-- guard no longer refuses anything.
CREATE OR REPLACE FUNCTION ag_refuse_while_converting()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_setting('anygrid.converting', true) IS NOT DISTINCT FROM TG_ARGV[0] THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jobs
    WHERE id = TG_ARGV[0]::uuid AND status IN ('queued', 'running')
  ) THEN
    RAISE EXCEPTION 'Table converting';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

-- A conversion writes its values beside the field before it knows it will
-- finish: that is no change of the row, whose "last modified" stays. Once
-- the field has its new values, the rows whose value changed are stamped.
CREATE OR REPLACE FUNCTION ag_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  actor uuid;
BEGIN
  BEGIN
    actor := nullif(current_setting('anygrid.user_id', true), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      actor := NULL;
  END;
  IF TG_OP = 'INSERT' THEN
    NEW.ag_created_by := coalesce(NEW.ag_created_by, actor);
    NEW.ag_updated_by := actor;
    NEW.ag_updated_at := now();
    RETURN NEW;
  END IF;
  NEW.ag_seq := OLD.ag_seq;
  NEW.ag_created_at := OLD.ag_created_at;
  NEW.ag_created_by := OLD.ag_created_by;
  IF nullif(current_setting('anygrid.converting', true), '') IS NOT NULL THEN
    IF current_setting('anygrid.conversion_stamp', true) = 'on' THEN
      NEW.ag_updated_at := now();
      NEW.ag_updated_by := actor;
    ELSE
      NEW.ag_updated_at := OLD.ag_updated_at;
      NEW.ag_updated_by := OLD.ag_updated_by;
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'ag_status' - 'ag_updated_at' - 'ag_updated_by' - 'ag_position')
     IS DISTINCT FROM (to_jsonb(OLD) - 'ag_status' - 'ag_updated_at' - 'ag_updated_by' - 'ag_position') THEN
    NEW.ag_updated_at := now();
    NEW.ag_updated_by := actor;
  ELSE
    NEW.ag_updated_at := OLD.ag_updated_at;
    NEW.ag_updated_by := OLD.ag_updated_by;
  END IF;
  RETURN NEW;
END;
$$;
