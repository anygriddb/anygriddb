-- The structure of a base leaves an event on the change trail: the base
-- itself (made, renamed, put in the trash, restored), its views that
-- everyone shares, its dashboards and their widgets, and its folders.
-- What only arranges the screen is not an event: the order of views and
-- folders, and where a widget sits. Nor is a person's own view, which
-- nobody else reads: the trail is read by administrators. Who put a
-- thing in the trash is in the event's author; the column that keeps
-- it is not watched, so clearing it when an account is erased is silent.
SELECT set_config('anygrid.migrate', 'on', true);--> statement-breakpoint
-- The function of migration 0091, with a view's event filed under its table.
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
CREATE TRIGGER audit_catalog
  AFTER INSERT OR DELETE ON bases
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "description", "deleted_at"
  ON bases
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
-- A view everyone shares has no owner. One that becomes shared, or stops
-- being, is an event too.
CREATE TRIGGER audit_catalog
  AFTER INSERT ON views
  FOR EACH ROW
  WHEN (NEW.owner_id IS NULL)
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog_gone
  AFTER DELETE ON views
  FOR EACH ROW
  WHEN (OLD.owner_id IS NULL)
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "config", "locked", "owner_id", "deleted_at"
  ON views
  FOR EACH ROW
  WHEN (NEW.owner_id IS NULL OR OLD.owner_id IS NULL)
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog
  AFTER INSERT OR DELETE ON dashboards
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "description"
  ON dashboards
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog
  AFTER INSERT OR DELETE ON dashboard_widgets
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "kind", "title", "config"
  ON dashboard_widgets
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog
  AFTER INSERT OR DELETE ON table_folders
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "deleted_at"
  ON table_folders
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
