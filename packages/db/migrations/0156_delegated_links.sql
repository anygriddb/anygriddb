-- One notion of delegated access (ADR 0131, §5), the rest of it: a
-- person's calendar feeds, public links, and an automation's inbound
-- secret join the tokens in `delegated_accesses`, row for row: ids, dates
-- and hashes kept, nothing issued again. What the code filters, updates
-- and follows by reference stays in columns of its own, each held to its
-- kinds: the view a feed or a link shows, the base a whole base's link
-- shows, the automation a secret starts, a link's settings and password.
SELECT set_config('anygrid.migrate', 'on', true);
ALTER TABLE "delegated_accesses"
  ADD COLUMN "view_id" uuid REFERENCES "views" ("id") ON DELETE CASCADE,
  ADD COLUMN "base_id" uuid REFERENCES "bases" ("id") ON DELETE CASCADE,
  ADD COLUMN "automation_id" uuid REFERENCES "automations" ("id") ON DELETE CASCADE,
  ADD COLUMN "allow_copy" boolean,
  ADD COLUMN "embed_origins" jsonb,
  ADD COLUMN "password_hash" text,
  ADD COLUMN "password_failures" integer,
  ADD COLUMN "password_locked_until" timestamptz,
  ADD CONSTRAINT "delegated_accesses_feed" CHECK (
    "kind" <> 'feed' OR ("view_id" IS NOT NULL AND "base_id" IS NULL)
  ),
  -- A link shows a view or a whole base, never both.
  ADD CONSTRAINT "delegated_accesses_link" CHECK (
    "kind" <> 'link' OR (
      ("view_id" IS NULL) <> ("base_id" IS NULL)
      AND "allow_copy" IS NOT NULL
      AND "password_failures" IS NOT NULL
      AND "password_failures" >= 0 AND "password_failures" < 10
    )
  ),
  ADD CONSTRAINT "delegated_accesses_inbound_hook"
    CHECK ("kind" <> 'inbound_hook' OR "automation_id" IS NOT NULL),
  ADD CONSTRAINT "delegated_accesses_link_only" CHECK (
    "kind" = 'link' OR ("base_id" IS NULL AND "allow_copy" IS NULL
      AND "embed_origins" IS NULL AND "password_hash" IS NULL
      AND "password_failures" IS NULL AND "password_locked_until" IS NULL)
  ),
  ADD CONSTRAINT "delegated_accesses_view_kinds"
    CHECK ("view_id" IS NULL OR "kind" IN ('feed', 'link')),
  ADD CONSTRAINT "delegated_accesses_automation_kind"
    CHECK ("automation_id" IS NULL OR "kind" = 'inbound_hook'),
  ADD CONSTRAINT "delegated_accesses_embed_origins" CHECK (
    "embed_origins" IS NULL OR (
      jsonb_typeof("embed_origins") = 'array'
      AND jsonb_array_length("embed_origins") <= 20
    )
  );
-- One live feed a person per view, one live inbound secret an automation;
-- revoked ones stay beside them.
CREATE UNIQUE INDEX "delegated_accesses_feed_of" ON "delegated_accesses"
  ("view_id", "author_id") WHERE "kind" = 'feed' AND "revoked_at" IS NULL;
CREATE UNIQUE INDEX "delegated_accesses_hook_of" ON "delegated_accesses"
  ("automation_id") WHERE "kind" = 'inbound_hook' AND "revoked_at" IS NULL;
CREATE INDEX "delegated_accesses_view" ON "delegated_accesses" ("view_id")
  WHERE "view_id" IS NOT NULL;
CREATE INDEX "delegated_accesses_base" ON "delegated_accesses" ("base_id")
  WHERE "base_id" IS NOT NULL;

INSERT INTO "delegated_accesses" ("id", "kind", "author_id", "name",
  "secret_hash", "view_id", "created_at", "last_used_at")
SELECT f."id", 'feed', f."user_id", '', f."token_hash", f."view_id",
  f."created_at", f."last_used_at"
FROM "calendar_feeds" f;

INSERT INTO "delegated_accesses" ("id", "kind", "author_id", "name",
  "secret_hash", "view_id", "base_id", "allow_copy", "embed_origins",
  "password_hash", "password_failures", "password_locked_until",
  "created_at", "ends_at", "revoked_at")
SELECT s."id", 'link', s."created_by", '', s."token_hash", s."view_id",
  s."base_id", s."allow_copy", s."embed_origins", s."password_hash",
  s."password_failures", s."password_locked_until", s."created_at",
  s."expires_at", s."revoked_at"
FROM "shares" s;

-- An automation without its author runs nothing: its secret goes.
INSERT INTO "delegated_accesses" ("kind", "author_id", "name",
  "secret_hash", "automation_id", "created_at")
SELECT 'inbound_hook', a."created_by", '', a."webhook_token_hash", a."id",
  a."created_at"
FROM "automations" a
WHERE a."webhook_token_hash" IS NOT NULL AND a."created_by" IS NOT NULL;

-- A file sent through a form waits on the link that took it.
ALTER TABLE "attachments"
  DROP CONSTRAINT "attachments_staged_share_id_fkey";
ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_staged_share_id_fkey"
  FOREIGN KEY ("staged_share_id") REFERENCES "delegated_accesses" ("id")
  ON DELETE CASCADE;

DROP TABLE "calendar_feeds";
DROP TABLE "shares";
DROP TRIGGER audit_catalog_settings ON "automations";
ALTER TABLE "automations" DROP COLUMN "webhook_token_hash";
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "enabled", "trigger", "actions", "created_by",
    "secrets"
  ON "automations"
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();

-- On the change trail, as each was: made, revoked, a link's settings and
-- password, its end, a feed's or a secret's new value; never a secret or
-- a password, even hashed, nor a token's use or an application's renewal.
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
  -- Nor a delegated access's secret (ADR 0131), nor a link's password,
  -- even hashed.
  IF TG_TABLE_NAME = 'delegated_accesses' THEN
    old_payload := old_payload - 'secret_hash' - 'password_hash';
    new_payload := new_payload - 'secret_hash' - 'password_hash';
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
  -- Automations: never the sealed secrets of its scripts. Their names and
  -- hosts stay: `secrets`.
  IF TG_TABLE_NAME = 'automations' THEN
    old_payload := old_payload - 'secrets_ciphertext' - 'secrets_nonce';
    new_payload := new_payload - 'secrets_ciphertext' - 'secrets_nonce';
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
  ELSIF TG_TABLE_NAME = 'delegated_accesses' THEN
    -- A feed and a view's link pin the view's table, an inbound secret its
    -- automation's; a token, or a whole base's link, no single table.
    IF payload ->> 'view_id' IS NOT NULL THEN
      SELECT table_id INTO subject FROM views WHERE id = (payload ->> 'view_id')::uuid;
    ELSIF payload ->> 'automation_id' IS NOT NULL THEN
      SELECT table_id INTO subject FROM automations
       WHERE id = (payload ->> 'automation_id')::uuid;
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

DROP TRIGGER audit_catalog_settings ON "delegated_accesses";
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "permissions", "base_ids", "revoked_at",
    "allow_copy", "embed_origins", "password_hash"
  ON "delegated_accesses"
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
CREATE TRIGGER audit_catalog_end
  AFTER UPDATE OF "ends_at" ON "delegated_accesses"
  FOR EACH ROW
  WHEN (NEW."kind" <> 'application')
  EXECUTE FUNCTION audit_catalog();
CREATE TRIGGER audit_catalog_secret
  AFTER UPDATE OF "secret_hash" ON "delegated_accesses"
  FOR EACH ROW
  WHEN (NEW."kind" IN ('feed', 'inbound_hook'))
  EXECUTE FUNCTION audit_catalog();
