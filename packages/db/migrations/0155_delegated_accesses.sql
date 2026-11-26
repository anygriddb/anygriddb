-- One notion of delegated access (ADR 0131, §5): what acts without its
-- author's session is one row of one table, whatever its kind. The tokens
-- come first: a person's API tokens and the applications they let in, the
-- tokens of the administration API and of provisioning (SCIM). Row for
-- row: ids, dates and hashes kept, nothing issued again. Feeds, links and
-- an automation's inbound secret follow.
CREATE TABLE "delegated_accesses" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('api_token', 'application',
    'admin_token', 'scim_token', 'feed', 'link', 'inbound_hook')),
  -- Whose rights it acts by.
  "author_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  -- The SHA-256 of its secret, never the secret.
  "secret_hash" text NOT NULL,
  -- What it was entrusted, of its author's: null, all they hold; the
  -- permissions of a base for a token, the administration API's scopes
  -- for one of its tokens.
  "permissions" text[],
  -- The bases it may reach; null, every base its author reaches.
  "base_ids" uuid[],
  -- The application a person let in.
  "client_id" uuid REFERENCES "oauth_clients" ("id") ON DELETE CASCADE,
  -- What its kind adds.
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "ends_at" timestamptz,
  "last_used_at" timestamptz,
  -- Revoked, it stays, and acts on nothing.
  "revoked_at" timestamptz,
  CONSTRAINT "delegated_accesses_secret_hash_unique" UNIQUE ("secret_hash"),
  CONSTRAINT "delegated_accesses_application_client"
    CHECK (("kind" = 'application') = ("client_id" IS NOT NULL)),
  CONSTRAINT "delegated_accesses_base_permissions" CHECK (
    "kind" NOT IN ('api_token', 'application')
    OR "permissions" IS NULL
    OR "permissions" <@ ARRAY[
      'rows.read', 'rows.comment', 'rows.write', 'rows.delete',
      'rows.lock', 'rows.transition', 'data.export', 'api.access',
      'data.import', 'publish', 'views.manage', 'dashboards.manage',
      'schema.manage', 'automations.manage', 'webhooks.manage',
      'members.manage', 'base.manage'
    ]::text[]
  ),
  CONSTRAINT "delegated_accesses_admin_permissions" CHECK (
    "kind" <> 'admin_token'
    OR ("permissions" IS NOT NULL AND cardinality("permissions") > 0
      AND "permissions" <@ ARRAY['accounts', 'invitations', 'settings']::text[])
  ),
  CONSTRAINT "delegated_accesses_admin_name"
    CHECK ("kind" <> 'admin_token' OR char_length("name") BETWEEN 1 AND 100),
  -- A token always ends; a feed or a link made before ends may not yet.
  CONSTRAINT "delegated_accesses_token_end" CHECK (
    "kind" NOT IN ('api_token', 'application', 'admin_token', 'scim_token')
    OR "ends_at" IS NOT NULL
  )
);
CREATE INDEX "delegated_accesses_author" ON "delegated_accesses" ("author_id");
CREATE INDEX "delegated_accesses_kind" ON "delegated_accesses" ("kind");
CREATE INDEX "delegated_accesses_client" ON "delegated_accesses" ("client_id")
  WHERE "client_id" IS NOT NULL;

-- A person's tokens. A read-only one held what a viewer may, and no more
-- than the role gave: it is entrusted exactly that. One kept from deleting
-- is entrusted every permission but deleting rows.
INSERT INTO "delegated_accesses" ("id", "kind", "author_id", "name",
  "secret_hash", "permissions", "base_ids", "client_id", "created_at",
  "ends_at", "last_used_at")
SELECT k."id",
  CASE WHEN k."oauth_client_id" IS NULL THEN 'api_token' ELSE 'application' END,
  k."user_id", k."name", k."token_hash",
  CASE
    WHEN k."read_only" THEN ARRAY['rows.read', 'data.export', 'api.access']::text[]
    WHEN NOT k."allow_delete" THEN ARRAY[
      'rows.read', 'rows.comment', 'rows.write', 'rows.lock',
      'rows.transition', 'data.export', 'api.access', 'data.import',
      'publish', 'views.manage', 'dashboards.manage', 'schema.manage',
      'automations.manage', 'webhooks.manage', 'members.manage',
      'base.manage'
    ]::text[]
  END,
  CASE WHEN jsonb_typeof(k."base_ids") = 'array' THEN ARRAY(
    SELECT b::uuid FROM jsonb_array_elements_text(k."base_ids") AS b
     WHERE b ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) END,
  k."oauth_client_id", k."created_at", k."expires_at", k."last_used_at"
FROM "api_tokens" k;

INSERT INTO "delegated_accesses" ("id", "kind", "author_id", "name",
  "secret_hash", "permissions", "created_at", "ends_at", "last_used_at")
SELECT t."id", 'admin_token', t."created_by", t."name", t."token_hash",
  ARRAY(SELECT jsonb_array_elements_text(t."scopes")),
  t."created_at", t."expires_at", t."last_used_at"
FROM "admin_tokens" t;

INSERT INTO "delegated_accesses" ("id", "kind", "author_id", "name",
  "secret_hash", "created_at", "ends_at", "last_used_at")
SELECT t."id", 'scim_token', t."created_by", t."name", t."token_hash",
  t."created_at", t."expires_at", t."last_used_at"
FROM "scim_tokens" t;

-- An application's refresh token renews the access it was issued with.
ALTER TABLE "oauth_refresh_tokens"
  DROP CONSTRAINT "oauth_refresh_tokens_api_token_id_fk";
ALTER TABLE "oauth_refresh_tokens" RENAME COLUMN "api_token_id" TO "access_id";
ALTER INDEX "oauth_refresh_tokens_api_token" RENAME TO "oauth_refresh_tokens_access";
ALTER TABLE "oauth_refresh_tokens"
  ADD CONSTRAINT "oauth_refresh_tokens_access_id_fk"
  FOREIGN KEY ("access_id") REFERENCES "delegated_accesses" ("id")
  ON DELETE CASCADE;

DROP TABLE "api_tokens";
DROP TABLE "admin_tokens";
DROP TABLE "scim_tokens";

-- Made, revoked, renamed, its reach changed: on the change trail, as the
-- administration and provisioning tokens were, and now a person's own
-- too. Neither a use nor the renewal of an application's secret is.
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
  -- Nor does a feed's token, even hashed.
  IF TG_TABLE_NAME = 'calendar_feeds' THEN
    old_payload := old_payload - 'token_hash';
    new_payload := new_payload - 'token_hash';
  END IF;
  -- Nor a delegated access's secret (ADR 0131), even hashed.
  IF TG_TABLE_NAME = 'delegated_accesses' THEN
    old_payload := old_payload - 'secret_hash';
    new_payload := new_payload - 'secret_hash';
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
  ELSIF TG_TABLE_NAME = 'attributions' AND payload ->> 'scope' = 'table' THEN
    subject := (payload ->> 'scope_id')::uuid;
  ELSIF TG_TABLE_NAME IN (
    'external_watches', 'external_syncs',
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
$$;

CREATE TRIGGER audit_catalog
  AFTER INSERT OR DELETE ON "delegated_accesses"
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "permissions", "base_ids", "revoked_at"
  ON "delegated_accesses"
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
