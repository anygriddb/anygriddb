-- A script of an automation calls an address with a secret its text
-- does not hold (ADR 0101): the automation keeps its secrets sealed, each
-- for one host, and says in `secrets` their names, their hosts, and when
-- each was set. The change trail keeps that list, never a sealed value.
SELECT set_config('anygrid.migrate', 'on', true);--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "secrets" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "secrets_ciphertext" bytea;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "secrets_nonce" bytea;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_catalog()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  actor uuid;
  reason text;
  origin text;
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
  origin := left(nullif(current_setting('anygrid.source', true), ''), 80);

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
  -- Nor does a feed's, a provisioning or an administration token, even
  -- hashed.
  IF TG_TABLE_NAME IN ('calendar_feeds', 'scim_tokens', 'admin_tokens') THEN
    old_payload := old_payload - 'token_hash';
    new_payload := new_payload - 'token_hash';
  END IF;
  -- Public links: never the token or password hash.
  IF TG_TABLE_NAME = 'shares' THEN
    old_payload := old_payload - 'token_hash' - 'password_hash';
    new_payload := new_payload - 'token_hash' - 'password_hash';
  END IF;
  -- Invitations: never the link token, nor the address invited. The
  -- trail names people by their account, and is kept when one is erased;
  -- an invitation taken becomes a role, which names its account.
  IF TG_TABLE_NAME = 'invitations' THEN
    old_payload := old_payload - 'token_hash' - 'email';
    new_payload := new_payload - 'token_hash' - 'email';
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
  -- Automations: never the webhook trigger token hash, nor the sealed
  -- secrets of its scripts. Their names and hosts stay: `secrets`.
  IF TG_TABLE_NAME = 'automations' THEN
    old_payload := old_payload - 'webhook_token_hash'
      - 'secrets_ciphertext' - 'secrets_nonce';
    new_payload := new_payload - 'webhook_token_hash'
      - 'secrets_ciphertext' - 'secrets_nonce';
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
    'webhooks', 'automations', 'views'
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

  INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason, source, catalog_table)
  VALUES (actor, 'catalog', subject, NULL, old_payload, new_payload, reason, origin, TG_TABLE_NAME);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER audit_catalog_settings ON automations;--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "enabled", "trigger", "actions", "webhook_token_hash",
    "created_by", "secrets"
  ON automations
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
