-- Rows keep the order people give them (ADR 0060). Each row of AnyGridDB's
-- own tables gets a place, ag_position, apart from ag_seq, which numbers a
-- row once and for ever. Rows are read by place, then by sequence. The rows
-- that exist keep their order: their place is their sequence number.

-- One sequence for every table: a new row takes its next value, so it comes
-- after every row placed so far, whatever table the numbers went to.
CREATE SEQUENCE ag_row_position AS bigint;

-- n places, in order, strictly between lo and hi, each with as few decimals
-- as the gap allows, so that putting rows in the same gap again and again
-- makes the numbers grow by a third of a digit each time. No lo: whole
-- numbers under hi. No hi: the sequence's next values. No gap between lo and
-- hi (two rows a restore put at one place): the rows take hi's.
CREATE FUNCTION ag_row_positions(lo numeric, hi numeric, n integer)
RETURNS numeric[]
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  step numeric;
  digits integer;
  result numeric[] := '{}';
BEGIN
  IF n IS NULL OR n < 1 THEN
    RETURN result;
  END IF;
  FOR i IN 1..n LOOP
    IF hi IS NULL THEN
      result := result || nextval('ag_row_position')::numeric;
    ELSIF lo IS NULL THEN
      result := result || (ceil(hi) - 1 - n + i);
    ELSIF lo >= hi THEN
      result := result || hi;
    ELSE
      IF step IS NULL THEN
        step := (hi - lo) / (n + 1);
        -- Rounded to 10^-digits, each place is off by a quarter of a step
        -- at most: the places stay apart and inside the gap.
        digits := greatest(0, ceil(-log(step / 2)))::integer;
      END IF;
      result := result || trim_scale(round(lo + step * i, digits));
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

-- A row moved is not a row changed: its place leaves its last change, and
-- who made it, as they were. The trail still records the move.
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

-- Each table is written once (ALTER ... USING fires no row trigger), then
-- indexed in the order rows are read, under the name the application gives
-- that index (ix_<table>_<FNV-1a of "ag_position">). The sequence starts
-- past every number a table has given, deleted rows included: a row
-- restored from the trash comes back at its own place.
DO $$
DECLARE
  rec record;
  top bigint := 0;
  given bigint;
BEGIN
  FOR rec IN
    SELECT physical_name FROM data_tables WHERE storage = 'native'
  LOOP
    IF to_regclass(quote_ident(rec.physical_name)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ADD COLUMN ag_position bigint', rec.physical_name);
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN ag_position TYPE numeric USING ag_seq',
      rec.physical_name
    );
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN ag_position SET DEFAULT nextval(''ag_row_position'')',
      rec.physical_name
    );
    EXECUTE format('ALTER TABLE %I ALTER COLUMN ag_position SET NOT NULL', rec.physical_name);
    EXECUTE format(
      'CREATE INDEX %I ON %I (ag_position, ag_seq)',
      'ix_' || substr(rec.physical_name, 3, 16) || '_d2700815',
      rec.physical_name
    );
    given := pg_sequence_last_value(
      pg_get_serial_sequence(quote_ident(rec.physical_name), 'ag_seq')::regclass
    );
    top := greatest(top, coalesce(given, 0));
  END LOOP;
  PERFORM setval('ag_row_position', top + 1, false);
END $$;
