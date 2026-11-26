-- A file no cell names any more is released (ADR 0136): since when, so that
-- undoing the change that took it out finds it for as long as the trash
-- keeps what is deleted, and storage counts only what is held.
ALTER TABLE "attachments" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint

-- The files a release job deletes, oldest first.
CREATE INDEX "attachments_released" ON "attachments" ("released_at")
  WHERE "released_at" IS NOT NULL;--> statement-breakpoint

-- What an account holds, summed when it sends a file.
CREATE INDEX "attachments_held_by" ON "attachments" ("created_by")
  WHERE "released_at" IS NULL;
