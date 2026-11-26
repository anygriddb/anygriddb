-- One table of attributions, by union (ADR 0131). A role given on a base
-- or a table, to a person or to a group, maybe narrowed on a table to some
-- rows and fields, maybe until a date. Roles add up: nothing given on a
-- table takes away what its base gives.
--
-- The roles a base or a table gives become attributions as they are (the
-- table is renamed: ids, dates and its trail stay). A group's role is one
-- row, no longer a copy for each member. A field or row rule rides on the
-- attribution it narrows. What cannot be kept exactly is what
-- `ag_rights_review()` (0149) names, read before anything moves, and the
-- check beside this file refuses the upgrade until it is accepted:
--   manager, group  the base's roles stay; a table that gave less now gives
--                   them too, and its rule goes;
--   ruled           the base's role goes; each table of the base gives what
--                   it gave, the ruled ones with their rule;
--   floor           the base's role falls to the floor, a role of exactly
--                   that set (one of the four, a made role, or one made
--                   here); each table that took the base's role keeps it.
-- Rules on someone with roles on tables alone move onto their table's
-- attribution; a rule that bound nobody goes.
SELECT set_config('anygrid.migrate', 'on', true);

CREATE TEMP TABLE "converting" ON COMMIT DROP AS
  SELECT "user_id", "base_id", "table_id", "kind", "permissions"
  FROM ag_rights_review();

CREATE TEMP TABLE "rules" ON COMMIT DROP AS
  SELECT coalesce(r."user_id", f."user_id") AS "user_id",
    coalesce(r."table_id", f."table_id") AS "table_id",
    r."row_filter",
    f."fields"
  FROM (
    SELECT "user_id", "table_id", "row_filter" FROM "table_acls"
    WHERE "row_filter" IS NOT NULL
  ) AS r
  FULL JOIN (
    SELECT "user_id", "table_id",
      jsonb_object_agg("column_name", "access"::text) AS "fields"
    FROM "column_acls"
    GROUP BY "user_id", "table_id"
  ) AS f ON f."user_id" = r."user_id" AND f."table_id" = r."table_id";

-- What a person's rights at a date before this upgrade are read back
-- from: the roles as they stood, a group's copies included.
CREATE TABLE "bindings_before_union" AS
  SELECT "id", "user_id", "group_id", "role", "made_role_id", "scope",
    "scope_id", "created_at"
  FROM "role_bindings";
ALTER TABLE "bindings_before_union" ADD PRIMARY KEY ("id");
CREATE INDEX "bindings_before_union_user" ON "bindings_before_union" ("user_id");

ALTER TABLE "role_bindings" RENAME TO "attributions";
ALTER TABLE "attributions" RENAME CONSTRAINT "role_bindings_pkey" TO "attributions_pkey";
ALTER TABLE "attributions" RENAME CONSTRAINT "role_bindings_one_role" TO "attributions_one_role";
ALTER INDEX "role_bindings_user" RENAME TO "attributions_user";
ALTER INDEX "role_bindings_scope" RENAME TO "attributions_scope_id";
ALTER INDEX "role_bindings_group" RENAME TO "attributions_group";
ALTER INDEX "role_bindings_made_role" RENAME TO "attributions_made_role";
DROP INDEX "role_bindings_direct";
DROP INDEX "role_bindings_from_group";

DELETE FROM "attributions" WHERE "group_id" IS NOT NULL;
DELETE FROM "attributions" WHERE "scope"::text NOT IN ('base', 'table');

ALTER TABLE "attributions"
  ALTER COLUMN "user_id" DROP NOT NULL,
  ALTER COLUMN "id" SET DEFAULT ag_uuidv7(),
  -- On a table only: the rows it reaches, and each field's access by the
  -- column's name (`hide`, `read`, `write`), a field not named hidden.
  ADD COLUMN "row_filter" jsonb,
  ADD COLUMN "field_access" jsonb,
  -- Past it the attribution gives nothing.
  ADD COLUMN "ends_at" timestamptz,
  ADD COLUMN "given_by" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  ADD CONSTRAINT "attributions_one_subject"
    CHECK (("user_id" IS NULL) <> ("group_id" IS NULL)),
  ADD CONSTRAINT "attributions_scope"
    CHECK ("scope"::text IN ('base', 'table')),
  ADD CONSTRAINT "attributions_rules_on_a_table"
    CHECK ("scope"::text = 'table'
      OR ("row_filter" IS NULL AND "field_access" IS NULL)),
  ADD CONSTRAINT "attributions_field_access"
    CHECK ("field_access" IS NULL OR jsonb_typeof("field_access") = 'object');
CREATE UNIQUE INDEX "attributions_person"
  ON "attributions" ("user_id", "scope", "scope_id")
  WHERE "user_id" IS NOT NULL;
CREATE UNIQUE INDEX "attributions_of_group"
  ON "attributions" ("group_id", "scope", "scope_id")
  WHERE "group_id" IS NOT NULL;
CREATE INDEX "attributions_given_by" ON "attributions" ("given_by")
  WHERE "given_by" IS NOT NULL;

-- A group's role, once.
INSERT INTO "attributions"
  ("id", "group_id", "role", "made_role_id", "scope", "scope_id", "created_at")
SELECT "id", "group_id", "role", "made_role_id", 'base', "base_id", "created_at"
FROM "group_roles";

-- ruled: a role on each table of the base, the one it took there.
INSERT INTO "attributions" ("user_id", "role", "made_role_id", "scope", "scope_id")
SELECT c."user_id", b."role", b."made_role_id", 'table', t."id"
FROM "converting" c
JOIN "attributions" b
  ON b."user_id" = c."user_id" AND b."scope" = 'base' AND b."scope_id" = c."base_id"
JOIN "data_tables" t ON t."base_id" = c."base_id"
WHERE c."kind" = 'ruled'
  AND NOT EXISTS (
    SELECT 1 FROM "attributions" x
    WHERE x."user_id" = c."user_id" AND x."scope" = 'table' AND x."scope_id" = t."id"
  );
DELETE FROM "attributions" b
USING "converting" c
WHERE c."kind" = 'ruled' AND b."user_id" = c."user_id"
  AND b."scope" = 'base' AND b."scope_id" = c."base_id";

-- floor: the base's role falls to what every narrowed table shares.
DO $$
DECLARE
  catalogue text[] := ARRAY['rows.read', 'rows.comment', 'rows.write',
    'rows.delete', 'rows.lock', 'rows.transition', 'data.export',
    'api.access', 'data.import', 'publish', 'views.manage',
    'dashboards.manage', 'schema.manage', 'automations.manage',
    'webhooks.manage', 'members.manage', 'base.manage'];
  f record;
  shipped role;
  made uuid;
  wanted jsonb;
  stem text;
  chosen text;
  tried integer;
BEGIN
  FOR f IN SELECT "user_id", "base_id", "permissions" FROM "converting"
           WHERE "kind" = 'floor' ORDER BY "user_id", "base_id" LOOP
    shipped := NULL;
    made := NULL;
    wanted := to_jsonb(ARRAY(
      SELECT p FROM unnest(f."permissions") AS p
      ORDER BY array_position(catalogue, p)
    ));
    SELECT k."role" INTO shipped FROM (VALUES
      ('viewer'::role, ARRAY['rows.read', 'data.export', 'api.access']),
      ('commenter'::role, ARRAY['rows.read', 'data.export', 'api.access',
        'rows.comment']),
      ('editor'::role, ARRAY['rows.read', 'data.export', 'api.access',
        'rows.comment', 'rows.write', 'rows.transition', 'rows.delete',
        'data.import', 'publish', 'views.manage']),
      ('owner'::role, catalogue)
    ) AS k ("role", "perms")
    WHERE k."perms" @> f."permissions" AND f."permissions" @> k."perms";
    IF shipped IS NULL THEN
      SELECT m."id" INTO made FROM "made_roles" m
      WHERE m."permissions" @> wanted AND wanted @> m."permissions"
      ORDER BY m."created_at", m."id"
      LIMIT 1;
    END IF;
    IF shipped IS NULL AND made IS NULL THEN
      SELECT 'Floor of ' || string_agg(DISTINCT n, ' and ' ORDER BY n)
      INTO stem
      FROM (
        SELECT coalesce(m."name", initcap(a."role"::text)) AS n
        FROM "attributions" a
        LEFT JOIN "made_roles" m ON m."id" = a."made_role_id"
        WHERE a."user_id" = f."user_id"
          AND ((a."scope" = 'base' AND a."scope_id" = f."base_id")
            OR (a."scope" = 'table' AND a."scope_id" IN (
              SELECT t."id" FROM "data_tables" t WHERE t."base_id" = f."base_id")))
      ) AS held;
      stem := left(coalesce(stem, 'Floor'), 70);
      chosen := stem;
      tried := 1;
      WHILE EXISTS (
        SELECT 1 FROM "made_roles" r WHERE lower(r."name") = lower(chosen)
      ) LOOP
        tried := tried + 1;
        chosen := stem || ' (' || tried || ')';
      END LOOP;
      INSERT INTO "made_roles" ("name", "permissions")
      VALUES (chosen, wanted)
      RETURNING "id" INTO made;
    END IF;
    INSERT INTO "attributions" ("user_id", "role", "made_role_id", "scope", "scope_id")
    SELECT f."user_id", b."role", b."made_role_id", 'table', t."id"
    FROM "attributions" b
    JOIN "data_tables" t ON t."base_id" = f."base_id"
    WHERE b."user_id" = f."user_id" AND b."scope" = 'base'
      AND b."scope_id" = f."base_id"
      AND NOT EXISTS (
        SELECT 1 FROM "attributions" x
        WHERE x."user_id" = f."user_id" AND x."scope" = 'table'
          AND x."scope_id" = t."id"
      );
    UPDATE "attributions"
    SET "role" = shipped, "made_role_id" = made
    WHERE "user_id" = f."user_id" AND "scope" = 'base'
      AND "scope_id" = f."base_id";
  END LOOP;
END;
$$;

-- A rule rides on the table's attribution it narrows; where the base's
-- roles stay over it, or it bound nobody, it goes.
UPDATE "attributions" a
SET "row_filter" = r."row_filter", "field_access" = r."fields"
FROM "rules" r
JOIN "data_tables" t ON t."id" = r."table_id"
WHERE a."user_id" = r."user_id" AND a."scope" = 'table'
  AND a."scope_id" = r."table_id"
  AND NOT EXISTS (
    SELECT 1 FROM "converting" c
    WHERE c."user_id" = r."user_id" AND c."kind" = 'idle_rule'
      AND c."table_id" = r."table_id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "converting" c
    WHERE c."user_id" = r."user_id" AND c."kind" IN ('manager', 'group')
      AND c."base_id" = t."base_id"
  );

DROP FUNCTION ag_rights_review();
DROP TABLE "group_roles";
DROP TABLE "column_acls";
DROP TABLE "table_acls";
DROP TYPE "column_access";

-- The trail names the attribution's table when it is on one.
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
