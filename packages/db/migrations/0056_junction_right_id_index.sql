-- Inverse link lookups join junctions on right_id. The primary key is
-- (left_id, right_id), which does not help that direction.
DO $$
DECLARE
  junction text;
  index_name text;
BEGIN
  FOR junction IN
    SELECT DISTINCT junction_name
    FROM relations
    WHERE junction_name IS NOT NULL
  LOOP
    index_name := 'ix_' || substr(replace(junction, '-', ''), 1, 24) || '_rid';
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I ("right_id")',
      index_name,
      junction
    );
  END LOOP;
END $$;
