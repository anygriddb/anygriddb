-- Short-lived locks that replace Redis keys (ADR 0009): who edits a cell
-- right now, and a button pressed twice in a row. Unlogged: a crash may
-- lose them, which only frees a lock early.
CREATE UNLOGGED TABLE "ephemeral_locks" (
  "key" text PRIMARY KEY,
  "owner" text NOT NULL,
  "expires_at" timestamptz NOT NULL
);--> statement-breakpoint
CREATE INDEX "ephemeral_locks_expires_idx" ON "ephemeral_locks" ("expires_at");
