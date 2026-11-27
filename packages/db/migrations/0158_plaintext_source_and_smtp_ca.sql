-- ADR 0139: a source may connect without TLS when an administrator opts in;
-- the mail relay may paste a certificate authority (verified TLS stays on).
ALTER TABLE "sources"
  ADD COLUMN "allow_plaintext" boolean NOT NULL DEFAULT false;--> statement-breakpoint
DROP TRIGGER audit_catalog_settings ON sources;--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "engine", "host", "port", "database", "username",
    "password_changed_at", "tls_ca", "connection_limit", "query_timeout_ms",
    "time_zone", "side_schema", "replica_host", "replica_port",
    "replica_database", "replica_username", "allow_plaintext"
  ON sources
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
ALTER TABLE "instance_smtp"
  ADD COLUMN "tls_ca" text;
