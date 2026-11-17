-- Three stores are no longer read (ADR 0104): the Redis wire protocol,
-- Cassandra, and Neo4j. A source of one of them is deleted with the
-- version before, by an administrator who knows what its tables fed:
-- nothing here deletes a base's tables for its owners. An enum keeps
-- every value it was ever given, so the type is made again without them.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "sources" WHERE "engine"::text IN ('redis', 'cassandra', 'neo4j')
  ) THEN
    RAISE EXCEPTION 'This version no longer reads Redis, Cassandra, or Neo4j: with the version before, delete the sources of those engines in Administration, then upgrade'
      USING ERRCODE = 'feature_not_supported';
  END IF;
END
$$;--> statement-breakpoint
-- The trigger names the column, which a change of type refuses: it comes
-- back below as migration 0047 left it.
DROP TRIGGER audit_catalog_settings ON sources;--> statement-breakpoint
ALTER TYPE "public"."source_engine" RENAME TO "source_engine_before_0116";--> statement-breakpoint
CREATE TYPE "public"."source_engine" AS ENUM (
  'postgres', 'mysql', 'mariadb', 'sqlserver', 'oracle', 'sqlite',
  'mongodb', 'opensearch'
);--> statement-breakpoint
ALTER TABLE "sources"
  ALTER COLUMN "engine" TYPE "public"."source_engine"
  USING "engine"::text::"public"."source_engine";--> statement-breakpoint
DROP TYPE "public"."source_engine_before_0116";--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "engine", "host", "port", "database", "username",
    "password_changed_at", "tls_ca", "connection_limit", "query_timeout_ms",
    "time_zone", "side_schema", "replica_host", "replica_port",
    "replica_database", "replica_username"
  ON sources
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
