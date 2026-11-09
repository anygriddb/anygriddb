-- Synced mode (ADRs 0006, 0034): a client's table read from a copy in
-- AnyGridDB's own database, refreshed on a schedule, for a DBA who
-- refuses live queries on a production database. The copy lives in the
-- `ag_sync` schema, one table per synced table, named after its id; its
-- rows keep the ids the client's table gives them, so views, comments,
-- statuses, and links stay as they are when the mode changes.
CREATE SCHEMA IF NOT EXISTS "ag_sync";--> statement-breakpoint
CREATE TABLE "external_syncs" (
  "table_id" uuid PRIMARY KEY REFERENCES "data_tables"("id") ON DELETE CASCADE,
  "interval_minutes" integer DEFAULT 15 NOT NULL CHECK ("interval_minutes" BETWEEN 1 AND 10080),
  -- The copy's columns and their types: [{ name, type }]. Null until the
  -- first copy is made; until then the table is read live.
  "columns" jsonb,
  "synced_at" timestamp with time zone,
  "row_count" bigint,
  "duration_ms" integer,
  -- Rows the last refresh found added, changed, or gone.
  "changes" integer DEFAULT 0 NOT NULL,
  -- Why the last refresh failed, as an error code; cleared by a success.
  "error_code" text,
  "error_at" timestamp with time zone,
  -- Bumped by every refresh: two refreshes of a table never both count.
  "version" integer DEFAULT 0 NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Choosing synced mode, or its interval, is a catalog change to audit;
-- a refresh is not.
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
  ELSIF TG_TABLE_NAME IN ('table_acls', 'column_acls', 'external_watches', 'external_syncs') THEN
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
  AFTER INSERT OR DELETE ON external_syncs
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "interval_minutes"
  ON external_syncs
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
