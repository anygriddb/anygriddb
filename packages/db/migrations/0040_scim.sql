-- SCIM 2.0 (ADR 0038): an identity provider creates, updates, and
-- deactivates accounts, and keeps groups. A base gives a group a role, and
-- each member gets it as a role binding of the group's.

-- What the provider calls an account: its own id, its user name, and
-- whether it removed the account (disabled, and gone from SCIM until the
-- provider creates it again).
ALTER TABLE "users" ADD COLUMN "scim_external_id" text UNIQUE;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "scim_user_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deprovisioned_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "users_scim_user_name" ON "users" (lower("scim_user_name"));--> statement-breakpoint

CREATE TABLE "groups" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "display_name" text NOT NULL,
  "external_id" text UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "groups_display_name" ON "groups" (lower("display_name"));--> statement-breakpoint

CREATE TABLE "group_members" (
  "group_id" uuid NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  PRIMARY KEY ("group_id", "user_id")
);--> statement-breakpoint
CREATE INDEX "group_members_user" ON "group_members" ("user_id");--> statement-breakpoint

-- The role a base gives a group.
CREATE TABLE "group_roles" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "group_id" uuid NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
  "base_id" uuid NOT NULL REFERENCES "bases"("id") ON DELETE CASCADE,
  "role" "role" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE ("group_id", "base_id")
);--> statement-breakpoint

-- A member's binding that a group gives: it follows the group's roles and
-- members, and goes with the group. A person's own bindings have none.
ALTER TABLE "role_bindings" ADD COLUMN "group_id" uuid REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "role_bindings_group" ON "role_bindings" ("group_id") WHERE "group_id" IS NOT NULL;--> statement-breakpoint

-- The provider's bearer tokens: only their SHA-256 is kept. A token goes
-- with the administrator who made it.
CREATE TABLE "scim_tokens" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "name" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone
);--> statement-breakpoint

-- Groups, the roles bases give them, and provisioning tokens are audited;
-- a token without its hash. Members show as the bindings they get.
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

CREATE TRIGGER audit_catalog
  AFTER INSERT OR UPDATE OR DELETE ON groups
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog
  AFTER INSERT OR UPDATE OR DELETE ON group_roles
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog
  AFTER INSERT OR DELETE ON scim_tokens
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
