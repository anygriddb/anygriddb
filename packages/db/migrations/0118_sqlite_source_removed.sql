-- A SQLite file is no longer read as a source (ADR 0107). A source of
-- that engine is deleted with the version before, by an administrator:
-- nothing here deletes a base's tables for its owners. The check beside
-- this file refuses before any migration runs (ADR 0106); this refusal
-- is for a database that reaches the migration another way. An enum
-- keeps every value it was ever given, so the type is made again
-- without it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "sources" WHERE "engine"::text = 'sqlite') THEN
    RAISE EXCEPTION 'This version no longer reads a SQLite file. Start the version before again and, with it, delete the tables of the SQLite sources from their bases, then from each base''s trash, then the sources themselves in Administration. Then upgrade'
      USING ERRCODE = 'feature_not_supported';
  END IF;
END
$$;--> statement-breakpoint
-- The trigger names the column, which a change of type refuses: it comes
-- back below as migration 0047 left it.
DROP TRIGGER audit_catalog_settings ON sources;--> statement-breakpoint
ALTER TYPE "public"."source_engine" RENAME TO "source_engine_before_0118";--> statement-breakpoint
CREATE TYPE "public"."source_engine" AS ENUM (
  'postgres', 'mysql', 'mariadb', 'sqlserver', 'oracle',
  'mongodb', 'opensearch'
);--> statement-breakpoint
ALTER TABLE "sources"
  ALTER COLUMN "engine" TYPE "public"."source_engine"
  USING "engine"::text::"public"."source_engine";--> statement-breakpoint
DROP TYPE "public"."source_engine_before_0118";--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "engine", "host", "port", "database", "username",
    "password_changed_at", "tls_ca", "connection_limit", "query_timeout_ms",
    "time_zone", "side_schema", "replica_host", "replica_port",
    "replica_database", "replica_username"
  ON sources
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
