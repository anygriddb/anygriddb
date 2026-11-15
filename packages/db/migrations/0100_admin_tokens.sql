-- Tokens of the administration API (ADR 0086): made by an administrator
-- with the proof, each for the scopes it names, shown once and kept as a
-- hash. One works while its maker is an active administrator. Making and
-- revoking one is on the change trail, without its hash.
SELECT set_config('anygrid.migrate', 'on', true);--> statement-breakpoint
CREATE TABLE "admin_tokens" (
	"id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_by" uuid NOT NULL
		REFERENCES "public"."users" ("id") ON DELETE CASCADE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "admin_tokens_token_hash_unique" UNIQUE ("token_hash"),
	CONSTRAINT "admin_tokens_name" CHECK (char_length("name") BETWEEN 1 AND 100),
	CONSTRAINT "admin_tokens_scopes" CHECK (
		jsonb_typeof("scopes") = 'array'
		AND "scopes" <> '[]'::jsonb
		AND "scopes" <@ '["accounts", "invitations", "settings"]'::jsonb
	)
);--> statement-breakpoint
CREATE INDEX "admin_tokens_created_by" ON "admin_tokens" ("created_by");--> statement-breakpoint
-- The function of migration 0092, which leaves this table's hash out too.
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
  AFTER INSERT OR DELETE ON admin_tokens
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
