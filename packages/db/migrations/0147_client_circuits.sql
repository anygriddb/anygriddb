-- A client's table has a circuit of its own (ADR 0137), as AnyGridDB's
-- tables do: its rows' states are kept beside them, a row with no entry in
-- the circuit's first state, and saving it keeps the rules a native
-- table's keeps (no row leaves a sealed state, a state rows are sealed in
-- stays sealed, a state that goes has its rows moved). A table without a
-- key has no states.
--
-- A step into a sealed state takes the state first and the seal once the
-- writes under way end: the state it left is kept beside it until then,
-- so that a step whose process stopped goes back there. A lock under way
-- (compliance's only sealing step until now) came from submitted.
ALTER TABLE "external_statuses"
  ADD COLUMN "fenced_from" text
  CHECK ("fenced_from" ~ '^[a-z][a-z0-9_]{0,63}$');--> statement-breakpoint
UPDATE "external_statuses" SET "fenced_from" = 'submitted'
 WHERE "status" = 'locked' AND "fingerprint" IS NULL;--> statement-breakpoint

-- A seal's date goes with its fingerprint, whatever its state is named:
-- a date with no fingerprint dates no seal, and none is read.
ALTER TABLE "external_statuses"
  DROP CONSTRAINT "external_statuses_sealed";--> statement-breakpoint
UPDATE "external_statuses" SET "sealed_at" = NULL
 WHERE "fingerprint" IS NULL AND "sealed_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "external_statuses"
  ADD CONSTRAINT "external_statuses_sealed" CHECK (
    "sealed_at" IS NULL OR "fingerprint" IS NOT NULL
  );--> statement-breakpoint

CREATE OR REPLACE FUNCTION ag_save_status_circuit(target_table uuid, definition jsonb, remap jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  said text := current_setting('anygrid.user_id', true);
  actor uuid;
  grid data_tables%ROWTYPE;
  former status_circuits%ROWTYPE;
  moves jsonb := coalesce(remap, '{}'::jsonb);
  states jsonb := definition -> 'states';
  steps jsonb := definition -> 'steps';
  pair record;
  sealed record;
  held bigint;
  new_id uuid;
  st jsonb;
  tr jsonb;
  new_state uuid;
  new_tr uuid;
  ids jsonb := '{}'::jsonb;
  place integer := 0;
  given text;
BEGIN
  IF said ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT id INTO actor FROM users WHERE id = said::uuid;
  END IF;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Audit context required';
  END IF;
  SELECT * INTO grid FROM data_tables WHERE id = target_table FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Table not found';
  END IF;
  -- A client's rows are named by their key: a table without one has no
  -- states to keep.
  IF grid.storage = 'external'
     AND coalesce(jsonb_array_length(grid.external_key), 0) = 0 THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;

  -- The definition's shape: 1 to 30 states, one of them the first, keys
  -- each once and written as a key is, at most 60 steps between them.
  IF jsonb_typeof(states) IS DISTINCT FROM 'array'
     OR jsonb_array_length(states) NOT BETWEEN 1 AND 30
     OR jsonb_typeof(steps) IS DISTINCT FROM 'array'
     OR jsonb_array_length(steps) > 60
     OR jsonb_typeof(moves) <> 'object'
     OR coalesce(btrim(definition ->> 'name'), '') = ''
     OR char_length(definition ->> 'name') > 60 THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(states) s
       WHERE (s ->> 'initial')::boolean) <> 1
     OR (SELECT count(DISTINCT s ->> 'key') FROM jsonb_array_elements(states) s)
        <> jsonb_array_length(states)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(states) s
        WHERE NOT (s ->> 'key') ~ '^[a-z][a-z0-9_]{0,63}$'
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(steps) t
        WHERE NOT (t ->> 'key') ~ '^[a-z][a-z0-9_]{0,63}$'
           OR NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(states) s
              WHERE s ->> 'key' = t ->> 'from'
           )
           OR NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(states) s
              WHERE s ->> 'key' = t ->> 'to'
           )
           OR t ->> 'from' = t ->> 'to'
           OR coalesce(t ->> 'signature', 'none') NOT IN ('none', 'password', 'step_up')
     ) THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;
  FOR pair IN SELECT key, value FROM jsonb_each_text(moves) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(states) s WHERE s ->> 'key' = pair.value
    ) THEN
      RAISE EXCEPTION 'Invalid status';
    END IF;
  END LOOP;

  SELECT * INTO former FROM status_circuits WHERE table_id = target_table FOR UPDATE;
  IF FOUND THEN
    -- A sealed row stays sealed: never moved, and its state stays a sealed
    -- one that neither writes nor deletes.
    FOR sealed IN
      SELECT key FROM status_states WHERE circuit_id = former.id AND seal
    LOOP
      IF moves ? sealed.key THEN
        RAISE EXCEPTION 'Row locked';
      END IF;
      IF grid.storage = 'external' THEN
        SELECT count(*) INTO held FROM external_statuses
         WHERE table_id = target_table AND status = sealed.key;
      ELSE
        EXECUTE format('SELECT count(*) FROM %I WHERE "ag_status" = $1', grid.physical_name)
          INTO held USING sealed.key;
      END IF;
      IF held > 0 AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(states) s
         WHERE s ->> 'key' = sealed.key
           AND (s ->> 'seal')::boolean
           AND NOT (s ->> 'writable')::boolean
           AND NOT (s ->> 'delete')::boolean
      ) THEN
        RAISE EXCEPTION 'Row locked';
      END IF;
    END LOOP;
    DELETE FROM status_circuits WHERE id = former.id;
  END IF;

  INSERT INTO status_circuits (table_id, key, name, system, duplicated_from_id)
  VALUES (target_table, 'custom', btrim(definition ->> 'name'), false, NULL)
  RETURNING id INTO new_id;

  FOR st IN SELECT value FROM jsonb_array_elements(states) LOOP
    INSERT INTO status_states (
      circuit_id, key, label, is_initial, row_writable, writable_fields,
      allow_delete, seal, position
    ) VALUES (
      new_id, st ->> 'key', left(btrim(st ->> 'label'), 100),
      (st ->> 'initial')::boolean, (st ->> 'writable')::boolean,
      CASE
        WHEN jsonb_typeof(st -> 'writableFields') = 'array'
          THEN ARRAY(SELECT jsonb_array_elements_text(st -> 'writableFields'))
        ELSE NULL
      END,
      (st ->> 'delete')::boolean, (st ->> 'seal')::boolean, place
    ) RETURNING id INTO new_state;
    ids := ids || jsonb_build_object(st ->> 'key', new_state::text);
    place := place + 1;
  END LOOP;

  place := 0;
  FOR tr IN SELECT value FROM jsonb_array_elements(steps) LOOP
    INSERT INTO status_transitions (
      circuit_id, from_state_id, to_state_id, key, label,
      require_reason, require_fields, signature, four_eyes, position
    ) VALUES (
      new_id, (ids ->> (tr ->> 'from'))::uuid, (ids ->> (tr ->> 'to'))::uuid,
      tr ->> 'key', left(btrim(tr ->> 'label'), 100),
      coalesce((tr ->> 'reason')::boolean, false),
      coalesce(ARRAY(SELECT jsonb_array_elements_text(tr -> 'fields')), '{}'),
      coalesce(tr ->> 'signature', 'none'),
      coalesce((tr ->> 'fourEyes')::boolean, false),
      place
    ) RETURNING id INTO new_tr;
    FOR given IN SELECT jsonb_array_elements_text(coalesce(tr -> 'roles', '[]')) LOOP
      INSERT INTO status_transition_grants (transition_id, role_key)
      VALUES (new_tr, given);
    END LOOP;
    FOR given IN SELECT jsonb_array_elements_text(coalesce(tr -> 'madeRoles', '[]')) LOOP
      INSERT INTO status_transition_grants (transition_id, made_role_id)
      VALUES (new_tr, given::uuid);
    END LOOP;
    place := place + 1;
  END LOOP;

  PERFORM set_config('anygrid.action', 'remap', true);
  FOR pair IN SELECT key, value FROM jsonb_each_text(moves) LOOP
    IF grid.storage = 'external' THEN
      UPDATE external_statuses SET status = pair.value, version = version + 1
       WHERE table_id = target_table AND status = pair.key;
    ELSE
      EXECUTE format('UPDATE %I SET "ag_status" = $1 WHERE "ag_status" = $2', grid.physical_name)
        USING pair.value, pair.key;
    END IF;
  END LOOP;
  PERFORM set_config('anygrid.action', '', true);

  -- No row is left in a state the circuit does not have. A client's row
  -- with no entry is in the first state, whichever it is.
  IF grid.storage = 'external' THEN
    SELECT count(*) INTO held FROM external_statuses
     WHERE table_id = target_table
       AND status NOT IN (SELECT key FROM status_states WHERE circuit_id = new_id);
  ELSE
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE "ag_status" NOT IN (SELECT key FROM status_states WHERE circuit_id = $1)',
      grid.physical_name
    ) INTO held USING new_id;
  END IF;
  IF held > 0 THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;

  INSERT INTO audit_events (user_id, action, table_id, catalog_table, old_value, new_value, source)
  VALUES (
    actor,
    'catalog',
    target_table,
    'status_circuits',
    CASE WHEN former.id IS NULL THEN NULL ELSE jsonb_build_object('circuit', former.key, 'name', former.name) END,
    jsonb_build_object('circuit', 'custom', 'definition', definition, 'remap', moves),
    'structure'
  );
  RETURN new_id;
END;
$$;
