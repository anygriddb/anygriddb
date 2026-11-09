-- Changes other applications make in a client's tables (ADRs 0006, 0031).
-- An administrator chooses how each exposed table is watched: a column
-- the client's database sets on every change (a date and time, or SQL
-- Server's rowversion), or SQL Server's Change Tracking. A job reads what
-- changed since its cursor and tells open grids, webhooks, and
-- automations.
CREATE TYPE "external_watch_method" AS ENUM ('column', 'change_tracking');--> statement-breakpoint
-- A client's row is named by its key as text, not a uuid: the runs and
-- deliveries its events cause name it so too (comments and notifications
-- already do, migration 0027).
ALTER TABLE "automation_matches" ALTER COLUMN "row_id" TYPE text USING "row_id"::text;--> statement-breakpoint
ALTER TABLE "automation_runs" ALTER COLUMN "row_id" TYPE text USING "row_id"::text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "row_id" TYPE text USING "row_id"::text;--> statement-breakpoint
CREATE TABLE "external_watches" (
  "table_id" uuid PRIMARY KEY REFERENCES "data_tables"("id") ON DELETE CASCADE,
  "method" "external_watch_method" NOT NULL,
  -- The client's column, for the `column` method.
  "column_name" text,
  "interval_seconds" integer DEFAULT 30 NOT NULL CHECK ("interval_seconds" BETWEEN 5 AND 86400),
  -- Where the last check stopped: a column's value, a Change Tracking
  -- version. Null until the first check, which only takes its bearings.
  "cursor" jsonb,
  -- Bumped by every check: two checks of the same table never both count.
  "version" integer DEFAULT 0 NOT NULL,
  "checked_at" timestamp with time zone,
  "changed_at" timestamp with time zone,
  -- Rows the last check found changed.
  "changes" integer DEFAULT 0 NOT NULL,
  -- Why the last check failed, as an error code; cleared by a success.
  "error_code" text,
  "error_at" timestamp with time zone,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "external_watches_column" CHECK (("method" = 'column') = ("column_name" IS NOT NULL))
);--> statement-breakpoint
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
  ELSIF TG_TABLE_NAME IN ('table_acls', 'column_acls', 'external_watches') THEN
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
  AFTER INSERT OR DELETE ON external_watches
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
-- A check moves the cursor and its state; only a change of settings is a
-- catalog change to audit.
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "method", "column_name", "interval_seconds"
  ON external_watches
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
