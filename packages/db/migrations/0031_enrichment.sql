-- Fields AnyGridDB adds to a client's tables (ADRs 0006, 0032): a status,
-- notes, a date of its own. They live in a side table, in a schema of the
-- client's database its DBA gives AnyGridDB, never in the client's table:
-- one side table per exposed table, keyed like it, joined to it on read.
ALTER TABLE "sources" ADD COLUMN "side_schema" text;--> statement-breakpoint
-- The side table's name, made at the first field added.
ALTER TABLE "data_tables" ADD COLUMN "external_side" text;--> statement-breakpoint
-- A field kept in the side table: its physical name is the side column's.
ALTER TABLE "data_columns" ADD COLUMN "external_side" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DROP TRIGGER audit_catalog_settings ON sources;--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "engine", "host", "port", "database", "username",
    "password_changed_at", "tls_ca", "connection_limit", "query_timeout_ms",
    "time_zone", "side_schema"
  ON sources
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
