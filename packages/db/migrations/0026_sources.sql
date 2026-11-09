-- Client databases AnyGridDB reads (ADRs 0006, 0026). The password is
-- encrypted with AUTH_ENCRYPTION_KEY and never leaves the server.
CREATE TYPE "source_engine" AS ENUM ('postgres', 'mysql', 'mariadb', 'sqlserver');--> statement-breakpoint
CREATE TABLE "sources" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "name" text NOT NULL,
  "engine" "source_engine" NOT NULL,
  "host" text NOT NULL,
  "port" integer NOT NULL CHECK ("port" BETWEEN 1 AND 65535),
  "database" text NOT NULL,
  "username" text NOT NULL,
  "password_ciphertext" bytea NOT NULL,
  "password_nonce" bytea NOT NULL,
  -- When the password last changed: the audit trail shows that, not it.
  "password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- A pasted certificate authority or self-signed certificate (PEM);
  -- without one, the system's authorities are trusted.
  "tls_ca" text,
  "connection_limit" integer DEFAULT 5 NOT NULL CHECK ("connection_limit" BETWEEN 1 AND 50),
  "query_timeout_ms" integer DEFAULT 15000 NOT NULL CHECK ("query_timeout_ms" BETWEEN 1000 AND 300000),
  -- What the last connection check found.
  "server_version" text,
  "checked_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "sources_name" ON "sources" (lower("name"));--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_catalog()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  actor uuid;
  reason text;
  subject uuid;
  payload jsonb;
  old_payload jsonb;
  new_payload jsonb;
BEGIN
  IF current_setting('anygrid.migrate', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  BEGIN
    actor := nullif(current_setting('anygrid.user_id', true), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Audit context required';
  END;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Audit context required';
  END IF;

  reason := nullif(current_setting('anygrid.reason', true), '');

  IF TG_OP = 'DELETE' THEN
    payload := to_jsonb(OLD);
    old_payload := payload;
    new_payload := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    payload := to_jsonb(NEW);
    old_payload := to_jsonb(OLD);
    new_payload := payload;
  ELSE
    payload := to_jsonb(NEW);
    old_payload := NULL;
    new_payload := payload;
  END IF;

  -- A source's password, even encrypted, never enters the audit trail.
  IF TG_TABLE_NAME = 'sources' THEN
    old_payload := old_payload - 'password_ciphertext' - 'password_nonce';
    new_payload := new_payload - 'password_ciphertext' - 'password_nonce';
  END IF;

  IF TG_TABLE_NAME = 'data_tables' THEN
    subject := (payload ->> 'id')::uuid;
  ELSIF TG_TABLE_NAME = 'data_columns' THEN
    subject := (payload ->> 'table_id')::uuid;
  ELSIF TG_TABLE_NAME = 'relations' THEN
    subject := (payload ->> 'to_table_id')::uuid;
  ELSIF TG_TABLE_NAME = 'role_bindings' AND payload ->> 'scope' = 'table' THEN
    subject := (payload ->> 'scope_id')::uuid;
  ELSIF TG_TABLE_NAME IN ('table_acls', 'column_acls') THEN
    subject := (payload ->> 'table_id')::uuid;
  ELSE
    subject := NULL;
  END IF;

  INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason)
  VALUES (actor, 'catalog', subject, NULL, old_payload, new_payload, reason);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_catalog
  AFTER INSERT OR DELETE ON sources
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
-- A connection check records what it found; only a change of settings
-- (or of the password, by its date) is a catalog change to audit.
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "engine", "host", "port", "database", "username",
    "password_changed_at", "tls_ca", "connection_limit", "query_timeout_ms"
  ON sources
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
