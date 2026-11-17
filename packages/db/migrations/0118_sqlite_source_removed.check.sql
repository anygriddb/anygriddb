-- Asked before any pending migration runs (ADR 0106): refused here, the
-- upgrade changes nothing, and the version before starts again to delete
-- the sources.
DO $$
BEGIN
  IF to_regclass('public.sources') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "sources" WHERE "engine"::text = 'sqlite') THEN
      RAISE EXCEPTION 'This version no longer reads a SQLite file. Start the version before again and, with it, delete the tables of the SQLite sources from their bases, then from each base''s trash, then the sources themselves in Administration. Then upgrade'
        USING ERRCODE = 'feature_not_supported';
    END IF;
  END IF;
END
$$;
