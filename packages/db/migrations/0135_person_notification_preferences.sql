-- Person notification preferences (ADR 0123): per-event channels, instance
-- defaults, mutes of a noisy base or table, and a queue for digests.
-- Accounts that had notify_by_email off keep collaborative events in-app
-- only; the column then goes.

CREATE TABLE "notification_defaults" (
  "event" text NOT NULL,
  "channels" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  PRIMARY KEY ("event"),
  CONSTRAINT "notification_defaults_event" CHECK (
    "event" IN (
      'mention',
      'reply',
      'assigned',
      'automation',
      'webhook_disabled',
      'row_changed',
      'role_given',
      'owner_named',
      'account_locked',
      'admin_access',
      'acting_as',
      'password_changed',
      'factors_removed',
      'sso_linked',
      'locked',
      'inactive_soon',
      'inactive_disabled'
    )
  ),
  CONSTRAINT "notification_defaults_channels" CHECK (
    jsonb_typeof("channels") = 'array'
    AND "channels" <@ '["in_app", "email_immediate", "email_daily", "email_weekly"]'::jsonb
  )
);

CREATE TABLE "notification_preferences" (
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "event" text NOT NULL,
  "channels" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "event"),
  CONSTRAINT "notification_preferences_event" CHECK (
    "event" IN (
      'mention',
      'reply',
      'assigned',
      'automation',
      'webhook_disabled',
      'row_changed',
      'role_given',
      'owner_named',
      'account_locked',
      'admin_access',
      'acting_as',
      'password_changed',
      'factors_removed',
      'sso_linked',
      'locked',
      'inactive_soon',
      'inactive_disabled'
    )
  ),
  CONSTRAINT "notification_preferences_channels" CHECK (
    jsonb_typeof("channels") = 'array'
    AND "channels" <@ '["in_app", "email_immediate", "email_daily", "email_weekly"]'::jsonb
  )
);

CREATE TABLE "notification_mutes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "base_id" uuid REFERENCES "bases" ("id") ON DELETE CASCADE,
  "table_id" uuid REFERENCES "data_tables" ("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notification_mutes_target" CHECK (
    ("base_id" IS NOT NULL AND "table_id" IS NULL)
    OR ("base_id" IS NOT NULL AND "table_id" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "notification_mutes_base"
  ON "notification_mutes" ("user_id", "base_id")
  WHERE "table_id" IS NULL;

CREATE UNIQUE INDEX "notification_mutes_table"
  ON "notification_mutes" ("user_id", "table_id")
  WHERE "table_id" IS NOT NULL;

CREATE INDEX "notification_mutes_user"
  ON "notification_mutes" ("user_id");

CREATE TABLE "notification_digest_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "event" text NOT NULL,
  "period" text NOT NULL,
  "table_id" uuid REFERENCES "data_tables" ("id") ON DELETE SET NULL,
  "row_id" uuid,
  "payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notification_digest_period" CHECK (
    "period" IN ('daily', 'weekly')
  ),
  CONSTRAINT "notification_digest_event" CHECK (
    "event" IN (
      'mention',
      'reply',
      'assigned',
      'automation',
      'webhook_disabled',
      'row_changed',
      'role_given',
      'owner_named',
      'account_locked',
      'admin_access',
      'acting_as',
      'password_changed',
      'factors_removed',
      'sso_linked',
      'locked',
      'inactive_soon',
      'inactive_disabled'
    )
  )
);

CREATE INDEX "notification_digest_due"
  ON "notification_digest_items" ("period", "user_id", "created_at");

-- Accounts that had email off: collaborative events stay in the app only.
-- Accounts that had it on inherit the built-in defaults (no row).
INSERT INTO "notification_preferences" ("user_id", "event", "channels")
SELECT
  u."id",
  e."event",
  '["in_app"]'::jsonb
FROM "users" u
CROSS JOIN (
  VALUES
    ('mention'),
    ('reply'),
    ('assigned'),
    ('automation'),
    ('webhook_disabled'),
    ('row_changed'),
    ('role_given'),
    ('owner_named')
) AS e ("event")
WHERE u."notify_by_email" = false
  AND u."id" <> '00000000-0000-0000-0000-000000000000';

ALTER TABLE "users" DROP COLUMN "notify_by_email";
