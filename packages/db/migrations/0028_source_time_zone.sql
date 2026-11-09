-- The time zone a source's dates without one are read in (ADR 0005).
ALTER TABLE "sources" ADD COLUMN "time_zone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
DROP TRIGGER audit_catalog_settings ON sources;--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "engine", "host", "port", "database", "username",
    "password_changed_at", "tls_ca", "connection_limit", "query_timeout_ms",
    "time_zone"
  ON sources
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
