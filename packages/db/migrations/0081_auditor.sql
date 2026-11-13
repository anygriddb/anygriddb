-- An auditor reads Administration and changes nothing (ROADMAP #34,
-- ADR 0071). Given by an administrator, beside administration and support.
ALTER TABLE "users" ADD COLUMN "is_auditor" boolean DEFAULT false NOT NULL;
