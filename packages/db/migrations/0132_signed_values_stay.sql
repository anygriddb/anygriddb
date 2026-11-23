-- The owner's functions are what the role the application signs in as can
-- still do to the structure (ADR 0119). A signed or locked row keeps its
-- values through them, and what they take away is said on the trail, by the
-- function itself: a stolen account calling one directly leaves the same trace.

-- How many locked or signed rows hold a value in a column, or are in a table.
-- For a junction, which has no status: how many it links.
CREATE FUNCTION ag_signed_rows_holding(tbl text, col text)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  rel regclass := to_regclass(quote_ident(tbl));
  found bigint := 0;
  linked bigint;
  link record;
BEGIN
  IF rel IS NULL THEN
    RETURN 0;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = rel AND attname = 'ag_status' AND NOT attisdropped
  ) THEN
    IF col IS NULL THEN
      EXECUTE format(
        'SELECT count(*) FROM %s WHERE "ag_status" IN (''locked'', ''signed'')',
        rel
      ) INTO found;
    ELSIF EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = rel AND attname = col AND NOT attisdropped
    ) THEN
      EXECUTE format(
        'SELECT count(*) FROM %s WHERE "ag_status" IN (''locked'', ''signed'') AND %I IS NOT NULL',
        rel, col
      ) INTO found;
    END IF;
    RETURN found;
  END IF;
  FOR link IN
    SELECT c.confrelid::regclass AS target, a.attname AS side
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.conrelid = rel AND c.contype = 'f'
       AND EXISTS (
         SELECT 1 FROM pg_attribute s
          WHERE s.attrelid = c.confrelid AND s.attname = 'ag_status'
            AND NOT s.attisdropped
       )
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %s j JOIN %s r ON r."id" = j.%I WHERE r."ag_status" IN (''locked'', ''signed'')',
      rel, link.target, link.side
    ) INTO linked;
    found := found + linked;
  END LOOP;
  RETURN found;
END;
$$;--> statement-breakpoint
-- Written by the function that drops, under the account the session names
-- when there is one: the values stay in the rows' history.
CREATE FUNCTION ag_note_structure_loss(tbl text, col text, held bigint)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  said text := current_setting('anygrid.user_id', true);
  actor uuid;
  grid uuid;
BEGIN
  IF said ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT id INTO actor FROM users WHERE id = said::uuid;
  END IF;
  SELECT id INTO grid FROM data_tables WHERE physical_name = tbl;
  INSERT INTO audit_events (user_id, action, table_id, catalog_table, new_value, reason, source)
  VALUES (
    coalesce(actor, '00000000-0000-0000-0000-000000000000'::uuid),
    'catalog',
    grid,
    'structure',
    jsonb_build_object('dropped', jsonb_build_object(
      'table', tbl, 'column', col, 'lockedOrSignedRows', held
    )),
    'Locked or signed rows were in what was dropped',
    'structure'
  );
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION ag_signed_rows_holding(text, text), ag_note_structure_loss(text, text, bigint) FROM PUBLIC;--> statement-breakpoint
-- A value a signed row holds does not go. A link's column may, with its trace:
-- the row a link points to can be deleted for good.
CREATE OR REPLACE FUNCTION ag_drop_column(tbl text, col text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  held bigint;
BEGIN
  PERFORM ag_assert_table_name(tbl);
  PERFORM ag_assert_field_column(col);
  held := ag_signed_rows_holding(tbl, col);
  IF held > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conrelid = to_regclass(quote_ident(tbl))
         AND c.contype = 'f' AND a.attname = col
    ) THEN
      RAISE EXCEPTION 'Row locked';
    END IF;
    PERFORM ag_note_structure_loss(tbl, col, held);
  END IF;
  EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS %I', tbl, col);
END;
$$;--> statement-breakpoint
-- A record that goes whole shows no false signature: it goes, and says so.
CREATE OR REPLACE FUNCTION ag_drop_table(tbl text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  held bigint;
BEGIN
  PERFORM ag_assert_table_name(tbl);
  held := ag_signed_rows_holding(tbl, NULL);
  IF held > 0 THEN
    PERFORM ag_note_structure_loss(tbl, NULL, held);
  END IF;
  EXECUTE format('DROP TABLE IF EXISTS %I', tbl);
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ag_conversion_switch(tbl text, col text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM ag_assert_table_name(tbl);
  PERFORM ag_assert_field_column(col);
  IF ag_signed_rows_holding(tbl, NULL) > 0 THEN
    RAISE EXCEPTION 'Row locked';
  END IF;
  EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS %I', tbl, col);
  EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', tbl, left('ag_tmp_' || col, 63), col);
END;
$$;--> statement-breakpoint
-- The purge takes only what the instance's own retention lets go, and writes
-- what it took itself, under who chose that retention.
CREATE OR REPLACE FUNCTION ag_purge_audit_events(days integer, at_time timestamptz, batch integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  gone integer;
  kept text;
  chooser uuid;
  moment timestamptz;
  cutoff timestamptz;
BEGIN
  IF days IS NULL OR days < 365 OR days > 3650
    OR batch IS NULL OR batch < 1 OR batch > 5000
    OR at_time IS NULL THEN
    RAISE EXCEPTION 'Invalid purge';
  END IF;
  SELECT value #>> '{}', updated_by INTO kept, chooser
    FROM instance_settings WHERE key = 'auditRetentionDays';
  IF kept IS NULL OR kept !~ '^[0-9]{1,4}$' OR kept::integer = 0 OR days < kept::integer THEN
    RETURN 0;
  END IF;
  moment := least(at_time, now());
  cutoff := moment - days * interval '86400 seconds';
  PERFORM set_config('anygrid.purge_audit', 'on', true);
  DELETE FROM audit_events
   WHERE id IN (
     SELECT id FROM audit_events
      WHERE occurred_at < cutoff
      ORDER BY occurred_at
      LIMIT batch
   );
  GET DIAGNOSTICS gone = ROW_COUNT;
  PERFORM set_config('anygrid.purge_audit', '', true);
  IF gone > 0 THEN
    INSERT INTO audit_events (user_id, action, new_value, source, occurred_at)
    VALUES (
      coalesce(chooser, '00000000-0000-0000-0000-000000000000'::uuid),
      'purge',
      jsonb_build_object(
        'events', gone,
        'before', to_char(cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'days', days
      ),
      'retention',
      moment
    );
  END IF;
  RETURN gone;
END;
$$;--> statement-breakpoint
-- An erasure is on the sign-in trail whoever asked for it. The event keeps no
-- identity: its account goes with the row below.
CREATE OR REPLACE FUNCTION ag_erase_account(target uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  erased constant uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  IF target IS NULL OR target = erased
    OR NOT EXISTS (SELECT 1 FROM users WHERE id = target) THEN
    RAISE EXCEPTION 'Invalid account';
  END IF;
  PERFORM set_config('anygrid.anonymize', 'on', true);
  UPDATE audit_events SET user_id = erased WHERE user_id = target;
  UPDATE audit_events SET impersonated_user_id = erased
   WHERE impersonated_user_id = target;
  UPDATE row_signatures SET user_id = erased, display_name = 'Erased account'
   WHERE user_id = target;
  UPDATE external_writes SET user_id = erased WHERE user_id = target;
  UPDATE external_status_events SET user_id = erased WHERE user_id = target;
  UPDATE auth_events SET ip = NULL
   WHERE (user_id = target OR actor_id = target)
     AND NOT (action = 'account_erased' AND user_id IS NOT DISTINCT FROM target);
  PERFORM set_config('anygrid.anonymize', '', true);
  IF NOT EXISTS (
    SELECT 1 FROM auth_events WHERE action = 'account_erased' AND user_id = target
  ) THEN
    INSERT INTO auth_events (action, user_id) VALUES ('account_erased', target);
  END IF;
  DELETE FROM users WHERE id = target;
END;
$$;
