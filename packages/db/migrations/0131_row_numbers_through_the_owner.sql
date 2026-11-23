-- After a copy or a restore, a table's next row takes a number and a place
-- past those it was given. A sequence is moved by its owner (ADR 0119): the
-- role the application signs in as draws from it and sets none.
CREATE FUNCTION ag_set_row_number(tbl text, last_number text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM ag_assert_table_name(tbl);
  IF last_number IS NULL OR last_number !~ '^[0-9]{1,19}$' THEN
    RAISE EXCEPTION 'Invalid row number';
  END IF;
  PERFORM setval(
    pg_get_serial_sequence(format('%I', tbl), 'ag_seq'),
    greatest(last_number::bigint, 1)
  );
END;
$$;--> statement-breakpoint
-- The sequence every table shares only moves forward, to no place past what
-- a file may hold.
CREATE FUNCTION ag_advance_row_place(tbl text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM ag_assert_table_name(tbl);
  EXECUTE format(
    'SELECT setval(''ag_row_position'', ceil(s."top")::bigint) '
    || 'FROM (SELECT max("ag_position") AS "top" FROM %I WHERE "ag_position" <= 9007199254740992) s '
    || 'WHERE ceil(s."top") > (SELECT "last_value" FROM ag_row_position)',
    tbl
  );
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION ag_set_row_number(text, text), ag_advance_row_place(text) FROM PUBLIC;
