-- The flags that open the trail answer to the role that owns it (ADR 0119).
-- Any session can set a setting named `anygrid.*`: until now, that was enough
-- to delete an event, give it to another author, or write to the catalog with
-- no event at all. A purge and an erasure now go through a function of the
-- owner, which holds its own limits.
CREATE FUNCTION ag_role_owns_store(candidate name)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT pg_has_role(candidate, c.relowner, 'MEMBER')
    FROM pg_class c
   WHERE c.oid = 'public.audit_events'::regclass
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_audit_tampering()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND TG_TABLE_NAME = 'audit_events'
    AND current_setting('anygrid.purge_audit', true) = 'on'
    AND ag_role_owns_store(current_user) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
    AND current_setting('anygrid.anonymize', true) = 'on'
    AND ag_role_owns_store(current_user) THEN
    IF TG_TABLE_NAME = 'row_signatures'
      AND to_jsonb(NEW) - 'user_id' - 'display_name'
        = to_jsonb(OLD) - 'user_id' - 'display_name' THEN
      RETURN NEW;
    END IF;
    IF TG_TABLE_NAME <> 'row_signatures'
      AND to_jsonb(NEW) - 'user_id' - 'impersonated_user_id'
        = to_jsonb(OLD) - 'user_id' - 'impersonated_user_id' THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Audit immutable';
END;
$$;--> statement-breakpoint
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
  IF current_setting('anygrid.migrate', true) = 'on'
    AND ag_role_owns_store(session_user) THEN
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
-- Deletes a batch of the events older than `days` before `at_time`. The
-- shortest retention an instance can choose is a floor here too, and a date
-- to come does not bring the limit closer.
CREATE FUNCTION ag_purge_audit_events(days integer, at_time timestamptz, batch integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  gone integer;
BEGIN
  IF days IS NULL OR days < 365 OR days > 3650
    OR batch IS NULL OR batch < 1 OR batch > 5000
    OR at_time IS NULL THEN
    RAISE EXCEPTION 'Invalid purge';
  END IF;
  PERFORM set_config('anygrid.purge_audit', 'on', true);
  DELETE FROM audit_events
   WHERE id IN (
     SELECT id FROM audit_events
      WHERE occurred_at < least(at_time, now()) - days * interval '86400 seconds'
      ORDER BY occurred_at
      LIMIT batch
   );
  GET DIAGNOSTICS gone = ROW_COUNT;
  PERFORM set_config('anygrid.purge_audit', '', true);
  RETURN gone;
END;
$$;--> statement-breakpoint
-- Moves an account's trails to the erased account and deletes the account,
-- in one step: an author cannot be taken off the trail of an account that
-- stays. The event that says this account was erased keeps the address of
-- who erased it; every other address of the account goes.
CREATE FUNCTION ag_erase_account(target uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  erased constant uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  IF target IS NULL OR target = erased
    OR NOT EXISTS (SELECT 1 FROM users WHERE id = target) THEN
    RAISE EXCEPTION 'Invalid account';
  END IF;
  PERFORM set_config('anygrid.anonymize', 'on', true);
  UPDATE audit_events SET user_id = erased WHERE user_id = target;
  UPDATE audit_events SET impersonated_user_id = erased
   WHERE impersonated_user_id = target;
  UPDATE row_signatures SET user_id = erased, display_name = 'Erased account'
   WHERE user_id = target;
  UPDATE external_writes SET user_id = erased WHERE user_id = target;
  UPDATE external_status_events SET user_id = erased WHERE user_id = target;
  UPDATE auth_events SET ip = NULL
   WHERE (user_id = target OR actor_id = target)
     AND NOT (action = 'account_erased' AND user_id IS NOT DISTINCT FROM target);
  PERFORM set_config('anygrid.anonymize', '', true);
  DELETE FROM users WHERE id = target;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION ag_purge_audit_events(integer, timestamptz, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION ag_erase_account(uuid) FROM PUBLIC;
