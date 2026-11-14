-- A base's restore points (ROADMAP row 99, ADR 0077): its snapshot, rows
-- and files included, kept in the instance's store, listed on the base's
-- page, and read back into a new base in one step. Each one lasts as long
-- as the instance keeps them (`restorePointDays`), then goes with its file.
ALTER TYPE "public"."job_kind" ADD VALUE IF NOT EXISTS 'restore_point';
ALTER TYPE "public"."job_kind" ADD VALUE IF NOT EXISTS 'restore_base';

CREATE TABLE "restore_points" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7(),
  "base_id" uuid NOT NULL REFERENCES "bases" ("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "file_key" text NOT NULL UNIQUE,
  "size" bigint NOT NULL CHECK ("size" >= 0),
  "rows" bigint NOT NULL CHECK ("rows" >= 0),
  "files" integer NOT NULL CHECK ("files" >= 0),
  "note" text CHECK (char_length("note") BETWEEN 1 AND 200)
);

-- A base's points, newest first; the ones past their date, for the purge.
CREATE INDEX "restore_points_base_created_ix" ON "restore_points" ("base_id", "created_at" DESC);
CREATE INDEX "restore_points_expires_ix" ON "restore_points" ("expires_at");
