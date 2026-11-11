-- A one-to-many link is a foreign key column, and PostgreSQL indexes none
-- on its own. The other side of the link reads the rows that point to each
-- of its rows, and deleting a row clears the ones that pointed to it:
-- both read the whole table without an index. New links get theirs when
-- they are made; this gives one to the links that exist, under the name
-- the application would give it (ix_<table>_<FNV-1a of the column>).
DO $$
DECLARE
  link record;
  hash bigint;
  i int;
BEGIN
  FOR link IN
    SELECT t.physical_name AS table_name, c.name AS column_name
    FROM relations r
    JOIN data_columns c ON c.id = r.from_column_id
    JOIN data_tables t ON t.id = c.table_id
    WHERE r.kind = 'one_to_many'
      AND t.storage = 'native'
      -- The link's own side holds the column; its inverse stores nothing.
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns cols
        WHERE cols.table_schema = current_schema()
          AND cols.table_name = t.physical_name
          AND cols.column_name = c.name
          AND cols.data_type = 'uuid'
      )
  LOOP
    hash := 2166136261;
    FOR i IN 1..length(link.column_name) LOOP
      hash := ((hash # ascii(substr(link.column_name, i, 1))) * 16777619)
        % 4294967296;
    END LOOP;
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (%I)',
      'ix_' || substr(link.table_name, 3, 16) || '_' || lpad(to_hex(hash), 8, '0'),
      link.table_name,
      link.column_name
    );
  END LOOP;
END $$;
