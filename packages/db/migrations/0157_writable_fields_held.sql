-- A state's writable fields are held on AnyGridDB's own tables (ADR 0124).
-- The changed fields were found by comparing the names of the row's columns
-- before and after a write, which are always the same: none was found, and
-- a write to any field passed in a state that allows only some. They are
-- now the fields whose value changed. A client's table holds the same rule
-- in the application (ADR 0137).
CREATE OR REPLACE FUNCTION audit_record()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  actor uuid;
  reason text;
  origin text;
  grid_id uuid;
  chosen text;
  requested text;
  status_only boolean;
  circuit uuid;
  initial_key text;
  old_writable boolean;
  old_delete boolean;
  new_writable boolean;
  from_seal boolean;
  to_writable boolean;
  tr_key text;
  tr_to text;
  changed_cols text[];
  allowed text[];
  col text;
  audit_act text;
BEGIN
  BEGIN
    actor := nullif(current_setting('anygrid.user_id', true), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Audit context required';
  END;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Audit context required';
  END IF;

  BEGIN
    grid_id := nullif(current_setting('anygrid.table_id', true), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Audit context required';
  END;
  IF grid_id IS NULL THEN
    RAISE EXCEPTION 'Audit context required';
  END IF;

  reason := nullif(current_setting('anygrid.reason', true), '');
  origin := left(nullif(current_setting('anygrid.source', true), ''), 80);

  -- A table with no circuit of its own follows the shipped compliance one,
  -- as every table did before circuits.
  SELECT c.id INTO circuit FROM status_circuits c WHERE c.table_id = grid_id;
  IF circuit IS NULL THEN
    SELECT c.id INTO circuit FROM status_circuits c
     WHERE c.table_id IS NULL AND c.key = 'compliance';
  END IF;
  IF circuit IS NULL THEN
    RAISE EXCEPTION 'Audit context required';
  END IF;

  SELECT s.key INTO initial_key
    FROM status_states s
   WHERE s.circuit_id = circuit AND s.is_initial
   LIMIT 1;
  IF initial_key IS NULL THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.ag_status IS DISTINCT FROM initial_key THEN
      RAISE EXCEPTION 'Invalid status';
    END IF;
    INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason, source)
    VALUES (actor, 'insert', grid_id, NEW.id, NULL, to_jsonb(NEW), reason, origin);
    RETURN NEW;
  END IF;

  -- A circuit replaced by its owner's function moves the rows of a state
  -- it no longer has (ag_replace_status_circuit, which has refused to move
  -- a sealed one). Only whoever owns the table may: the application's own
  -- role does not, so setting the action alone does nothing.
  IF TG_OP = 'UPDATE'
     AND current_setting('anygrid.action', true) = 'remap'
     AND pg_has_role(
       current_user,
       (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID),
       'MEMBER'
     ) THEN
    IF (to_jsonb(NEW) - 'ag_status') IS DISTINCT FROM (to_jsonb(OLD) - 'ag_status')
       OR NOT EXISTS (
         SELECT 1 FROM status_states s
          WHERE s.circuit_id = circuit AND s.key = NEW.ag_status
       ) THEN
      RAISE EXCEPTION 'Invalid status';
    END IF;
    INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason, source)
    VALUES (actor, 'transition', grid_id, NEW.id, to_jsonb(OLD), to_jsonb(NEW), reason, origin);
    RETURN NEW;
  END IF;

  SELECT s.row_writable, s.allow_delete, s.seal
    INTO old_writable, old_delete, from_seal
    FROM status_states s
   WHERE s.circuit_id = circuit AND s.key = OLD.ag_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF NOT old_delete THEN
      RAISE EXCEPTION 'Row locked';
    END IF;
    INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason, source)
    VALUES (actor, 'delete', grid_id, OLD.id, to_jsonb(OLD), NULL, reason, origin);
    RETURN OLD;
  END IF;

  status_only := (to_jsonb(NEW) - 'ag_status') = (to_jsonb(OLD) - 'ag_status');
  requested := current_setting('anygrid.action', true);

  IF NEW.ag_status IS DISTINCT FROM OLD.ag_status THEN
    IF NOT status_only THEN
      RAISE EXCEPTION 'Invalid status';
    END IF;
    SELECT tr.key, to_s.key, to_s.row_writable
      INTO tr_key, tr_to, to_writable
      FROM status_transitions tr
      JOIN status_states from_s ON from_s.id = tr.from_state_id
      JOIN status_states to_s ON to_s.id = tr.to_state_id
     WHERE tr.circuit_id = circuit
       AND from_s.key = OLD.ag_status
       AND to_s.key = NEW.ag_status
       AND tr.key = requested
     LIMIT 1;
    IF tr_key IS NULL THEN
      -- Unlock-style: destination writable, source not, flag set, matching unlock transition.
      IF current_setting('anygrid.unlock', true) = 'on' THEN
        SELECT tr.key, to_s.key, to_s.row_writable
          INTO tr_key, tr_to, to_writable
          FROM status_transitions tr
          JOIN status_states from_s ON from_s.id = tr.from_state_id
          JOIN status_states to_s ON to_s.id = tr.to_state_id
         WHERE tr.circuit_id = circuit
           AND from_s.key = OLD.ag_status
           AND to_s.key = NEW.ag_status
           AND to_s.row_writable
           AND NOT from_s.row_writable
         LIMIT 1;
      END IF;
    END IF;
    IF tr_key IS NULL OR tr_to IS DISTINCT FROM NEW.ag_status THEN
      RAISE EXCEPTION 'Invalid status';
    END IF;
    IF tr_key IN ('submit', 'lock', 'unlock', 'sign') THEN
      audit_act := tr_key;
    ELSE
      audit_act := 'transition';
    END IF;
    chosen := audit_act;
  ELSE
    IF NOT old_writable THEN
      RAISE EXCEPTION 'Row locked';
    END IF;
    SELECT s.writable_fields INTO allowed
      FROM status_states s
     WHERE s.circuit_id = circuit AND s.key = OLD.ag_status;
    IF allowed IS NOT NULL THEN
      -- The fields whose value changed. A system column (`ag_*`, which no
      -- field may be named) is the row's own or a conversion's, not a field.
      SELECT array_agg(n.key) INTO changed_cols
        FROM jsonb_each(to_jsonb(NEW)) n
        JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
       WHERE n.key <> 'id'
         AND left(n.key, 3) <> 'ag_'
         AND n.value IS DISTINCT FROM o.value;
      IF changed_cols IS NOT NULL THEN
        FOREACH col IN ARRAY changed_cols LOOP
          IF NOT (col = ANY (allowed)) THEN
            RAISE EXCEPTION 'Row locked';
          END IF;
        END LOOP;
      END IF;
    END IF;
    chosen := 'update';
  END IF;

  INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason, source)
  VALUES (actor, chosen::audit_action, grid_id, NEW.id, to_jsonb(OLD), to_jsonb(NEW), reason, origin);
  RETURN NEW;
END;
$$;
