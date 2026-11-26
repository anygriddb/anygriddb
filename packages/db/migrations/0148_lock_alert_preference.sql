-- Whether an administrator hears of an account that locks, and how, is one
-- choice: their notification preferences (ADR 0123), which also say by
-- which channel. Administration's alert choices kept a second switch for
-- it (ROADMAP #48). An administrator who turned it off there keeps it off,
-- as a preference with no channel, whatever channels they had chosen.
INSERT INTO "notification_preferences" ("user_id", "event", "channels")
SELECT "user_id", 'account_locked', '[]'::jsonb
  FROM "alert_optouts"
 WHERE "kind" = 'account_locked'
ON CONFLICT ("user_id", "event")
DO UPDATE SET "channels" = '[]'::jsonb, "updated_at" = now();--> statement-breakpoint

DELETE FROM "alert_optouts" WHERE "kind" = 'account_locked';--> statement-breakpoint

ALTER TABLE "alert_optouts" DROP CONSTRAINT "alert_optouts_kind_check";--> statement-breakpoint
ALTER TABLE "alert_optouts" ADD CONSTRAINT "alert_optouts_kind_check" CHECK (
  "kind" IN (
    'backup_late',
    'backup_failed',
    'storage_full',
    'certificate_expiring',
    'source_unreachable',
    'failures'
  )
);
