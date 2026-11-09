-- Statuses and signatures on a client's rows (ADRs 0007, 0033). A client's
-- table has no status column, and AnyGridDB never adds one: the status of
-- each row that left draft lives here, named by the row's key as text.
-- Locking a row seals it: AnyGridDB keeps the values it stored then and
-- their SHA-256 fingerprint, and a job compares the row with them, so a
-- change made elsewhere is detected and told.
CREATE TYPE "external_status" AS ENUM ('submitted', 'locked', 'signed');--> statement-breakpoint
CREATE TABLE "external_statuses" (
  "table_id" uuid NOT NULL REFERENCES "data_tables"("id") ON DELETE CASCADE,
  "row_id" text NOT NULL,
  "status" "external_status" NOT NULL,
  -- The stored fields and their values when the row was locked, canonical,
  -- and the SHA-256 of that form. Null until the lock read the row.
  "sealed" jsonb,
  "fingerprint" text,
  "sealed_at" timestamp with time zone,
  -- Bumped by every change of status: two changes never both count.
  "version" integer DEFAULT 0 NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The last comparison with the row, and what differed: null while the
  -- row holds its sealed values.
  "checked_at" timestamp with time zone,
  "drift" jsonb,
  "drift_at" timestamp with time zone,
  PRIMARY KEY ("table_id", "row_id"),
  CONSTRAINT "external_statuses_sealed" CHECK (
    "status" = 'submitted' OR "sealed_at" IS NULL OR "fingerprint" IS NOT NULL
  )
);--> statement-breakpoint
CREATE INDEX "external_statuses_check" ON "external_statuses" ("checked_at" NULLS FIRST)
  WHERE "status" IN ('locked', 'signed');--> statement-breakpoint
-- What happened to a client row's status, append-only like the audit
-- trail: submit, lock (with the sealed values and their fingerprint), sign,
-- unlock, and what the checks found: changed, restored.
CREATE TABLE "external_status_events" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Null for what a check found.
  "user_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
  -- No foreign key: the trail outlives the table, as audit_events does.
  "table_id" uuid NOT NULL,
  "row_id" text NOT NULL,
  "action" text NOT NULL CHECK ("action" IN ('submit', 'lock', 'unlock', 'sign', 'changed', 'restored')),
  "fingerprint" text,
  "detail" jsonb,
  "reason" text,
  -- web, api, automation:<id>, check
  "source" text
);--> statement-breakpoint
CREATE INDEX "external_status_events_table_row" ON "external_status_events" ("table_id", "row_id");--> statement-breakpoint
REVOKE UPDATE, DELETE ON "external_status_events" FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER enforce_external_status_event_immutability
  BEFORE UPDATE OR DELETE ON external_status_events
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_tampering();--> statement-breakpoint
-- A signature names a client's row by its key, and records the
-- fingerprint of the values it signs.
ALTER TABLE "row_signatures" ALTER COLUMN "record_id" TYPE text USING "record_id"::text;--> statement-breakpoint
ALTER TABLE "row_signatures" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TYPE "notification_kind" ADD VALUE 'row_changed';
