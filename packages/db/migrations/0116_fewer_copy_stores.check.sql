-- Asked before any pending migration runs (ADR 0106): refused here, the
-- upgrade changes nothing, and the version before starts again to delete
-- the sources. Migration 0116 asks the same of a database that reached
-- it another way.
DO $$
BEGIN
  IF to_regclass('public.sources') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM "sources" WHERE "engine"::text IN ('redis', 'cassandra', 'neo4j')
    ) THEN
      RAISE EXCEPTION 'This version no longer reads Redis, Cassandra, or Neo4j. Start the version before again and, with it, delete the tables of those sources from their bases, then from each base''s trash, then the sources themselves in Administration. Then upgrade'
        USING ERRCODE = 'feature_not_supported';
    END IF;
  END IF;
END
$$;
