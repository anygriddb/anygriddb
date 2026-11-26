-- Administration in the same model as a base (ADR 0131, §4): each of its
-- five shipped roles (administrator, support, auditor, account manager,
-- source manager) is an attribution at the instance, given to a person.
-- Row for row, nothing lost: each true column of `users` and each row of
-- `instance_roles` becomes one, the columns and the table go. No role of
-- the instance is made by hand.
SELECT set_config('anygrid.migrate', 'on', true);

ALTER TABLE "attributions"
  ALTER COLUMN "scope_id" DROP NOT NULL,
  ADD COLUMN "instance_role" text,
  DROP CONSTRAINT "attributions_one_role",
  DROP CONSTRAINT "attributions_scope";

INSERT INTO "attributions" ("user_id", "instance_role", "scope", "created_at")
SELECT u."id", r."role", 'instance', now()
FROM "users" u
CROSS JOIN LATERAL (
  VALUES ('administrator', u."is_admin"), ('support', u."is_support"),
    ('auditor', u."is_auditor")
) AS r ("role", "held")
WHERE r."held";

INSERT INTO "attributions" ("user_id", "instance_role", "scope", "created_at")
SELECT "user_id", "role", 'instance', "granted_at" FROM "instance_roles";

ALTER TABLE "attributions"
  ADD CONSTRAINT "attributions_one_role"
    CHECK (num_nonnulls("role", "made_role_id", "instance_role") = 1),
  ADD CONSTRAINT "attributions_scope"
    CHECK ("scope"::text IN ('instance', 'base', 'table')),
  -- The instance has no id; a base and a table have theirs.
  ADD CONSTRAINT "attributions_scope_id"
    CHECK (("scope"::text = 'instance') = ("scope_id" IS NULL)),
  -- A role of the instance is one of its five, given to a person.
  ADD CONSTRAINT "attributions_instance_role"
    CHECK (("scope"::text = 'instance') = ("instance_role" IS NOT NULL)),
  ADD CONSTRAINT "attributions_instance_role_known"
    CHECK ("instance_role" IS NULL OR "instance_role" IN ('administrator',
      'support', 'auditor', 'account_manager', 'source_manager')),
  ADD CONSTRAINT "attributions_instance_person"
    CHECK ("scope"::text <> 'instance' OR "user_id" IS NOT NULL);
CREATE UNIQUE INDEX "attributions_instance"
  ON "attributions" ("user_id", "instance_role")
  WHERE "instance_role" IS NOT NULL;

DROP TABLE "instance_roles";
ALTER TABLE "users"
  DROP COLUMN "is_admin",
  DROP COLUMN "is_support",
  DROP COLUMN "is_auditor";
