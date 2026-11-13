-- The alerts an administrator asked not to be told about (ROADMAP #48).
-- No row: every alert reaches them, as before.
CREATE TABLE "alert_optouts" (
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK (
    "kind" IN (
      'backup_late',
      'backup_failed',
      'storage_full',
      'certificate_expiring',
      'source_unreachable',
      'failures',
      'account_locked'
    )
  ),
  PRIMARY KEY ("user_id", "kind")
);
