-- Lot 1 of the audit-coverage inventory: rights and data-egress writes
-- that had no trail (public shares, invitations, webhooks, automations,
-- group membership) go through audit_catalog. Secrets stay out of the
-- payloads. API token create is a new sign-in trail action.
SELECT set_config('anygrid.migrate', 'on', true);--> statement-breakpoint
ALTER TYPE "public"."auth_action" ADD VALUE IF NOT EXISTS 'token_created';--> statement-breakpoint
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
  target text;
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
  -- Public links: never the token or password hash.
  IF TG_TABLE_NAME = 'shares' THEN
    old_payload := old_payload - 'token_hash' - 'password_hash';
    new_payload := new_payload - 'token_hash' - 'password_hash';
  END IF;
  -- Invitations: never the link token.
  IF TG_TABLE_NAME = 'invitations' THEN
    old_payload := old_payload - 'token_hash';
    new_payload := new_payload - 'token_hash';
  END IF;
  -- Webhooks: never sealed secrets or headers; target without its query.
  IF TG_TABLE_NAME = 'webhooks' THEN
    old_payload := old_payload - 'secret_ciphertext' - 'secret_nonce'
      - 'headers_ciphertext' - 'headers_nonce';
    new_payload := new_payload - 'secret_ciphertext' - 'secret_nonce'
      - 'headers_ciphertext' - 'headers_nonce';
    IF old_payload ? 'target' THEN
      target := split_part(old_payload ->> 'target', '?', 1);
      old_payload := jsonb_set(old_payload, '{target}', to_jsonb(target));
    END IF;
    IF new_payload ? 'target' THEN
      target := split_part(new_payload ->> 'target', '?', 1);
      new_payload := jsonb_set(new_payload, '{target}', to_jsonb(target));
    END IF;
  END IF;
  -- Automations: never the webhook trigger token hash.
  IF TG_TABLE_NAME = 'automations' THEN
    old_payload := old_payload - 'webhook_token_hash';
    new_payload := new_payload - 'webhook_token_hash';
  END IF;

  IF TG_TABLE_NAME = 'data_tables' THEN
    subject := (payload ->> 'id')::uuid;
  ELSIF TG_TABLE_NAME = 'data_columns' THEN
    subject := (payload ->> 'table_id')::uuid;
  ELSIF TG_TABLE_NAME = 'relations' THEN
    subject := (payload ->> 'to_table_id')::uuid;
  ELSIF TG_TABLE_NAME = 'role_bindings' AND payload ->> 'scope' = 'table' THEN
    subject := (payload ->> 'scope_id')::uuid;
  ELSIF TG_TABLE_NAME IN (
    'table_acls', 'column_acls', 'external_watches', 'external_syncs',
    'webhooks', 'automations'
  ) THEN
    subject := (payload ->> 'table_id')::uuid;
  ELSIF TG_TABLE_NAME = 'calendar_feeds' THEN
    SELECT table_id INTO subject FROM views WHERE id = (payload ->> 'view_id')::uuid;
  ELSIF TG_TABLE_NAME = 'shares' THEN
    -- A view link pins the table; a whole-base link has no single table.
    IF payload ->> 'view_id' IS NOT NULL THEN
      SELECT table_id INTO subject FROM views WHERE id = (payload ->> 'view_id')::uuid;
    ELSE
      subject := NULL;
    END IF;
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
-- Public links: create, revoke, and settings; not password-failure counters.
CREATE TRIGGER audit_catalog
  AFTER INSERT OR DELETE ON shares
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "revoked_at", "expires_at", "allow_copy", "embed_origins", "password_hash"
  ON shares
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
-- Invitations: create, withdraw, accept, renew (token / expiry).
CREATE TRIGGER audit_catalog
  AFTER INSERT OR DELETE ON invitations
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "accepted_at", "expires_at", "role", "token_hash"
  ON invitations
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
-- Webhooks: create, delete, and config; not delivery failure counters.
CREATE TRIGGER audit_catalog
  AFTER INSERT OR DELETE ON webhooks
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "active", "events", "name", "filter", "watch_columns",
    "include_values", "target", "kind", "secret_ciphertext", "secret_nonce",
    "headers_ciphertext", "headers_nonce", "created_by", "disabled_reason"
  ON webhooks
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
-- Automations: create, delete, and definition; not run watermarks.
CREATE TRIGGER audit_catalog
  AFTER INSERT OR DELETE ON automations
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "enabled", "trigger", "actions", "webhook_token_hash",
    "created_by"
  ON automations
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
-- Group membership: add and remove.
CREATE TRIGGER audit_catalog
  AFTER INSERT OR DELETE ON group_members
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
