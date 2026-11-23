-- A copy the instance makes of its own base (a restore point, a base's copy)
-- writes each row with the dates and authors it had, and makes its links
-- without marking the row as changed (ADR 0117). Only that writer asks, for
-- its own transaction. A row is still inserted as a draft: its status comes
-- back through the transitions the trail records. What a conversion writes
-- beside a field keeps the rule migration 0125 gave it.
CREATE OR REPLACE FUNCTION ag_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  actor uuid;
  keeping boolean;
BEGIN
  BEGIN
    actor := nullif(current_setting('anygrid.user_id', true), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      actor := NULL;
  END;
  keeping := coalesce(current_setting('anygrid.keep_row_state', true), '') = 'on';
  IF TG_OP = 'INSERT' THEN
    IF keeping THEN
      RETURN NEW;
    END IF;
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
  IF NOT keeping
     AND (to_jsonb(NEW) - 'ag_status' - 'ag_updated_at' - 'ag_updated_by' - 'ag_position')
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
--> statement-breakpoint

-- An earlier version could import a row whose number or place nothing can
-- follow, and move the one sequence that places every table's new rows out
-- of reach. Such numbers are brought back next to the table's others, in the
-- order they had. The rows in range are not touched, and neither is anything
-- else of a row: the row triggers stand aside for these two columns, which
-- say where a row stands and nothing of what it holds, and only on a table
-- that needs it. A healthy instance is only read (ADR 0117).
DO $$
DECLARE
  far CONSTANT bigint := 4503599627370496;
  rec record;
  table_name text;
  own_sequence text;
  own_last bigint;
  top_seq numeric;
  high numeric;
  low numeric;
  deleted_top numeric;
  start_at numeric;
  moved bigint;
  repaired integer := 0;
  shared_last bigint;
  shared_top numeric := 0;
  table_top numeric;
BEGIN
  FOR rec IN
    SELECT id, physical_name FROM data_tables WHERE storage = 'native'
  LOOP
    table_name := rec.physical_name;
    CONTINUE WHEN to_regclass(quote_ident(table_name)) IS NULL;
    EXECUTE format(
      'SELECT max(ag_seq), max(ag_position), min(ag_position) FROM %I',
      table_name
    ) INTO top_seq, high, low;
    own_sequence := pg_get_serial_sequence(quote_ident(table_name), 'ag_seq');
    own_last := 0;
    IF own_sequence IS NOT NULL THEN
      EXECUTE format('SELECT last_value FROM %s', own_sequence) INTO own_last;
    END IF;
    CONTINUE WHEN coalesce(top_seq, 0) <= far
      AND coalesce(high, 0) <= far
      AND coalesce(low, 0) >= -far
      AND own_last <= far;

    EXECUTE format('ALTER TABLE %I DISABLE TRIGGER ag_stamp', table_name);
    EXECUTE format('ALTER TABLE %I DISABLE TRIGGER audit_record', table_name);

    -- A new number stays past every number the table gave, the deleted
    -- rows' included: a row brought back from the trash keeps its own.
    EXECUTE format(
      'SELECT max(ag_seq) FROM %I WHERE ag_seq <= %s', table_name, far
    ) INTO top_seq;
    SELECT max((old_value->>'ag_seq')::numeric) INTO deleted_top
    FROM audit_events
    WHERE table_id = rec.id
      AND action = 'delete'
      AND (old_value->>'ag_seq')::numeric <= far;
    start_at := greatest(top_seq, deleted_top, 0);
    -- Through negative numbers: each row's new number may be another's old.
    EXECUTE format(
      'UPDATE %1$I t SET ag_seq = -f.n FROM (
         SELECT id, row_number() OVER (ORDER BY ag_seq) AS n
         FROM %1$I WHERE ag_seq > %2$s
       ) f WHERE t.id = f.id',
      table_name, far
    );
    GET DIAGNOSTICS moved = ROW_COUNT;
    EXECUTE format(
      'UPDATE %I SET ag_seq = %s - ag_seq WHERE ag_seq < 0',
      table_name, start_at
    );
    IF own_sequence IS NOT NULL AND (own_last > far OR moved > 0) THEN
      PERFORM setval(own_sequence, greatest(
        (start_at + moved)::bigint,
        CASE WHEN own_last <= far THEN own_last ELSE 1 END,
        1
      ));
    END IF;

    -- Past the top above it, past the bottom below it, between two whole
    -- numbers: each keeps its order, and none leaves the range.
    EXECUTE format(
      'WITH bounds AS (
         SELECT coalesce(max(ag_position), 0) AS top,
                coalesce(min(ag_position), 0) AS bottom
         FROM %1$I WHERE ag_position BETWEEN -%2$s AND %2$s
       ), distant AS (
         SELECT id, ag_position > 0 AS above,
                row_number() OVER (PARTITION BY ag_position > 0
                                   ORDER BY ag_position, ag_seq) AS n,
                count(*) OVER (PARTITION BY ag_position > 0) AS total
         FROM %1$I WHERE ag_position > %2$s OR ag_position < -%2$s
       )
       UPDATE %1$I t SET ag_position = CASE
         WHEN d.above THEN b.top + d.n::numeric / (d.total + 1)
         ELSE b.bottom - (d.total - d.n + 1)::numeric / (d.total + 1)
       END
       FROM distant d, bounds b WHERE t.id = d.id',
      table_name, far
    );

    EXECUTE format('ALTER TABLE %I ENABLE TRIGGER audit_record', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE TRIGGER ag_stamp', table_name);
    repaired := repaired + 1;
    RAISE WARNING 'Row numbers of table % were brought back in range', rec.id;
  END LOOP;

  SELECT last_value INTO shared_last FROM ag_row_position;
  IF shared_last > far OR repaired > 0 THEN
    FOR rec IN
      SELECT physical_name FROM data_tables WHERE storage = 'native'
    LOOP
      CONTINUE WHEN to_regclass(quote_ident(rec.physical_name)) IS NULL;
      EXECUTE format('SELECT max(ag_position) FROM %I', rec.physical_name)
        INTO table_top;
      shared_top := greatest(shared_top, table_top);
    END LOOP;
    PERFORM setval(
      'ag_row_position',
      greatest(
        ceil(shared_top)::bigint,
        CASE WHEN shared_last <= far THEN shared_last ELSE 1 END,
        1
      )
    );
  END IF;
END;
$$;
