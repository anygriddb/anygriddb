-- ADR 0140: every requirement an administrator relaxed, in one table. A row
-- says that a requirement is relaxed, for what, by whom, and which
-- consequence was confirmed; no row is the strict default. A source's
-- clear connection (0158) and the private networks of Administration's
-- channels (a setting) move here, and their old places go.
CREATE TABLE "relaxations" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "key" text NOT NULL,
  -- The source it is relaxed for; null, the instance.
  "source_id" uuid REFERENCES "sources" ("id") ON DELETE CASCADE,
  -- The version of the consequence the administrator confirmed.
  "consequence" integer NOT NULL CHECK ("consequence" > 0),
  "enabled_by" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "enabled_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "relaxations_key"
    CHECK ("key" IN ('source.plaintext', 'notify.private_networks')),
  CONSTRAINT "relaxations_scope"
    CHECK (("key" = 'source.plaintext') = ("source_id" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "relaxations_once"
  ON "relaxations" ("key", "source_id") NULLS NOT DISTINCT;--> statement-breakpoint
CREATE INDEX "relaxations_source" ON "relaxations" ("source_id")
  WHERE "source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "relaxations_enabled_by" ON "relaxations" ("enabled_by")
  WHERE "enabled_by" IS NOT NULL;--> statement-breakpoint
-- Who ticked a source's box is not kept apart from its other changes: its
-- author stands for them, and the trail of the catalog keeps the change.
INSERT INTO "relaxations" ("key", "source_id", "consequence", "enabled_by")
  SELECT 'source.plaintext', "id", 1, "created_by"
    FROM "sources" WHERE "allow_plaintext";--> statement-breakpoint
INSERT INTO "relaxations"
    ("key", "consequence", "enabled_by", "enabled_at")
  SELECT 'notify.private_networks', 1, "updated_by", "updated_at"
    FROM "instance_settings"
   WHERE "key" = 'notifyAllowPrivate' AND "value" = 'true'::jsonb;--> statement-breakpoint
DELETE FROM "instance_settings" WHERE "key" = 'notifyAllowPrivate';--> statement-breakpoint
-- From now on, the change trail keeps each relaxation made and taken back,
-- with its source; the rows copied above were already there.
CREATE TRIGGER audit_catalog
  AFTER INSERT OR DELETE ON "relaxations"
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
DROP TRIGGER audit_catalog_settings ON sources;--> statement-breakpoint
CREATE TRIGGER audit_catalog_settings
  AFTER UPDATE OF "name", "engine", "host", "port", "database", "username",
    "password_changed_at", "tls_ca", "connection_limit", "query_timeout_ms",
    "time_zone", "side_schema", "replica_host", "replica_port",
    "replica_database", "replica_username"
  ON sources
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN "allow_plaintext";--> statement-breakpoint
ALTER TYPE "public"."auth_action" ADD VALUE IF NOT EXISTS 'relaxation_enabled';--> statement-breakpoint
ALTER TYPE "public"."auth_action" ADD VALUE IF NOT EXISTS 'relaxation_disabled';
