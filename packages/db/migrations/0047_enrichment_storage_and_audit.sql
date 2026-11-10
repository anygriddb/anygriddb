-- A read replica's password, even encrypted, stays out of the audit trail
-- like the primary's; changing where reads go, or how a synced table
-- refreshes, is a catalog change to audit.
--
-- A field AnyGridDB adds to a client's table records where its values
-- live (ADR 0046): naming a side schema later must not move a field kept
-- in AnyGridDB's database, nor the reverse.
SELECT set_config('anygrid.migrate', 'on', true);--> statement-breakpoint
ALTER TABLE "data_columns"
  ADD COLUMN "external_control_plane" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A side field always comes with its table's side table: a field of a
-- table that has none can only be kept in AnyGridDB's database.
UPDATE "data_columns" c SET "external_control_plane" = true
FROM "data_tables" t
WHERE c."table_id" = t."id" AND c."external_side" AND t."external_side" IS NULL;--> statement-breakpoint
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

  -- A source's passwords, even encrypted, never enter the audit trail.
  IF TG_TABLE_NAME = 'sources' THEN
    old_payload := old_payload - 'password_ciphertext' - 'password_nonce'
      - 'replica_password_ciphertext' - 'replica_password_nonce';
    new_payload := new_payload - 'password_ciphertext' - 'password_nonce'
      - 'replica_password_ciphertext' - 'replica_password_nonce';
  END IF;
  -- Nor does a feed's or a provisioning token, even hashed.
  IF TG_TABLE_NAME IN ('calendar_feeds', 'scim_tokens') THEN
    old_payload := old_payload - 'token_hash';
    new_payload := new_payload - 'token_hash';
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
  ELSIF TG_TABLE_NAME = 'calendar_feeds' THEN
    SELECT table_id INTO subject FROM views WHERE id = (payload ->> 'view_id')::uuid;
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
DROP TRIGGER audit_catalog_settings ON sources;--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "engine", "host", "port", "database", "username",
    "password_changed_at", "tls_ca", "connection_limit", "query_timeout_ms",
    "time_zone", "side_schema", "replica_host", "replica_port",
    "replica_database", "replica_username"
  ON sources
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
-- A refresh moves the watermark and its counters: not audited.
DROP TRIGGER audit_catalog_settings ON external_syncs;--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "interval_minutes", "sync_mode", "change_column", "full_every"
  ON external_syncs
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
