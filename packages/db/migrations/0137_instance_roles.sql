-- Delegated administration (ROADMAP #34, ADR 0126): an account manager and a
-- source manager, each given by an administrator beside administration,
-- support and the auditor. A role is a row; an erased account takes its
-- roles with it.
CREATE TABLE "instance_roles" (
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "role" text NOT NULL CHECK ("role" IN ('account_manager', 'source_manager')),
  "granted_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "role")
);
