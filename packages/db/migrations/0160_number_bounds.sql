-- A number field that refused negative numbers takes a smallest value of 0
-- instead (ADR 0141): one rule where there were two. The key goes from
-- every field that held it, those in the trash included.
SELECT set_config('anygrid.migrate', 'on', true);

UPDATE "data_columns"
SET "config" = ("config" - 'nonNegative')
  || CASE
       WHEN "config" ->> 'nonNegative' = 'true' AND NOT ("config" ? 'min')
         THEN jsonb_build_object('min', '0')
       ELSE '{}'::jsonb
     END
WHERE "config" ? 'nonNegative';
