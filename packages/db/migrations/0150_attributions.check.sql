-- Roles add up from this version on (ADR 0131): what the conversion cannot
-- keep exactly is counted by `ag_rights_review()`, which the release before
-- added with a page that lists it (migration 0149). The upgrade waits until
-- an operator has read and accepted it, by naming this migration in
-- ANYGRIDDB_ACCEPT_UPGRADE; nothing is written before.
DO $$
DECLARE
  accepted text[] := string_to_array(
    replace(coalesce(current_setting('anygriddb.accept_upgrade', true), ''), ' ', ''),
    ',');
  manager integer;
  grouped integer;
  ruled integer;
  floor integer;
  lost integer;
BEGIN
  IF to_regclass('public.role_bindings') IS NULL THEN
    RETURN;
  END IF;
  IF to_regprocedure('public.ag_rights_review()') IS NULL THEN
    IF EXISTS (SELECT 1 FROM role_bindings WHERE scope::text = 'table')
      OR EXISTS (SELECT 1 FROM table_acls)
      OR EXISTS (SELECT 1 FROM column_acls) THEN
      RAISE EXCEPTION 'Roles add up from this version on, and this instance gives roles on tables or field and row rules. Upgrade to 0.11.2 first: Administration › People › Rights to review lists whose access this version will change. Then upgrade to this one.';
    END IF;
    RETURN;
  END IF;
  IF '0150' = ANY (accepted) OR '0150_attributions' = ANY (accepted) THEN
    RETURN;
  END IF;
  SELECT
    count(*) FILTER (WHERE kind = 'manager'),
    count(*) FILTER (WHERE kind = 'group'),
    count(*) FILTER (WHERE kind = 'ruled'),
    count(*) FILTER (WHERE kind = 'floor'),
    count(*) FILTER (WHERE kind = 'base_only')
  INTO manager, grouped, ruled, floor, lost
  FROM ag_rights_review();
  IF manager + grouped + ruled + floor + lost > 0 THEN
    RAISE EXCEPTION 'Roles add up from this version on, and some access cannot stay exactly as it is: % table(s) widen to a manager''s role, % to a group''s, % role(s) on a base become a role on each of its tables, % role(s) on a base are lowered, % lose what only the base gives. Read them in Administration › People › Rights to review with the version before, and change them there or accept them: start again with ANYGRIDDB_ACCEPT_UPGRADE=0150.',
      manager, grouped, ruled, floor, lost;
  END IF;
END;
$$;
