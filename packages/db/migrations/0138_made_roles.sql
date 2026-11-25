-- Roles an administrator makes of the permissions of a base (ROADMAP #111,
-- ADR 0128): a name and the acts it gives, given on a base or a table as
-- one of the four is. A role someone holds cannot be deleted: they would
-- lose their access without anyone choosing it. An invitation goes with
-- its role: the application refuses while one waits, so only those taken
-- or expired go.
CREATE TABLE "made_roles" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "name" text NOT NULL CHECK (
    "name" = btrim("name") AND char_length("name") BETWEEN 1 AND 60
  ),
  -- A list of the catalogue's permissions (ADR 0127), reading rows first.
  "permissions" jsonb NOT NULL CHECK (
    jsonb_typeof("permissions") = 'array'
    AND "permissions" @> '["rows.read"]'::jsonb
    AND "permissions" <@ '[
      "rows.read", "rows.comment", "rows.write", "rows.delete", "rows.lock",
      "data.export", "data.import", "publish", "views.manage",
      "dashboards.manage", "schema.manage", "automations.manage",
      "webhooks.manage", "members.manage", "base.manage"
    ]'::jsonb
  ),
  "created_by" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "made_roles_name" ON "made_roles" (lower("name"));

CREATE TRIGGER audit_catalog
  AFTER INSERT OR UPDATE OR DELETE ON "made_roles"
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();

-- What is given is one of the four or a made role, never both.
ALTER TABLE "role_bindings"
  ALTER COLUMN "role" DROP NOT NULL,
  ADD COLUMN "made_role_id" uuid REFERENCES "made_roles" ("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "role_bindings_one_role"
    CHECK (("role" IS NULL) <> ("made_role_id" IS NULL));
CREATE INDEX "role_bindings_made_role" ON "role_bindings" ("made_role_id")
  WHERE "made_role_id" IS NOT NULL;

ALTER TABLE "group_roles"
  ALTER COLUMN "role" DROP NOT NULL,
  ADD COLUMN "made_role_id" uuid REFERENCES "made_roles" ("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "group_roles_one_role"
    CHECK (("role" IS NULL) <> ("made_role_id" IS NULL));
CREATE INDEX "group_roles_made_role" ON "group_roles" ("made_role_id")
  WHERE "made_role_id" IS NOT NULL;

ALTER TABLE "invitations"
  ALTER COLUMN "role" DROP NOT NULL,
  ADD COLUMN "made_role_id" uuid REFERENCES "made_roles" ("id") ON DELETE CASCADE,
  ADD CONSTRAINT "invitations_one_role"
    CHECK (("role" IS NULL) <> ("made_role_id" IS NULL));
CREATE INDEX "invitations_made_role" ON "invitations" ("made_role_id")
  WHERE "made_role_id" IS NOT NULL;
