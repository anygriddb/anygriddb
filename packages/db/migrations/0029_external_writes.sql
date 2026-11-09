-- Writes to a client's tables (ADRs 0006, 0007, 0028). An administrator
-- allows them per table, editing, adding, and deleting apart, within what
-- the source's account may do. A column takes changes when AnyGridDB
-- writes its type back exactly and the account may update it; it takes a
-- value in a new row when AnyGridDB writes its type back exactly.
ALTER TABLE "data_tables"
  ADD COLUMN "external_update" boolean DEFAULT false NOT NULL,
  ADD COLUMN "external_insert" boolean DEFAULT false NOT NULL,
  ADD COLUMN "external_delete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "data_tables" ADD CONSTRAINT "data_tables_external_writes" CHECK (
  "storage" = 'external'
  OR NOT ("external_update" OR "external_insert" OR "external_delete")
);--> statement-breakpoint
ALTER TABLE "data_columns"
  ADD COLUMN "external_writable" boolean DEFAULT false NOT NULL,
  ADD COLUMN "external_insertable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Each write AnyGridDB makes in a client's table, recorded in three steps
-- (ADR 0007): the intent, before the client's transaction commits; then
-- `applied` once it committed, and `confirmed` once the row read again
-- shows it. No transaction spans both databases: a job settles an intent
-- a crash left open by reading the row again (`abandoned` when the write
-- never happened, `unverified` when the row no longer tells).
CREATE TYPE "external_write_step" AS ENUM ('applied', 'confirmed', 'abandoned', 'unverified');--> statement-breakpoint
CREATE TABLE "external_writes" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  -- No foreign key: the trail outlives the table, as audit_events does.
  "table_id" uuid NOT NULL,
  "source_id" uuid NOT NULL,
  -- The row's id as AnyGridDB names it; for an insert, `applied` names it.
  "row_id" text,
  "action" "audit_action" NOT NULL CHECK ("action" IN ('insert', 'update', 'delete')),
  -- What the row held, read under lock, and what the write asked for.
  "old_value" jsonb,
  "new_value" jsonb,
  "reason" text,
  -- web, api, automation:<id>, …
  "source" text
);--> statement-breakpoint
CREATE INDEX "external_writes_table_row" ON "external_writes" ("table_id", "row_id");--> statement-breakpoint
CREATE INDEX "external_writes_requested_at" ON "external_writes" ("requested_at");--> statement-breakpoint
CREATE TABLE "external_write_steps" (
  "write_id" uuid NOT NULL REFERENCES "external_writes"("id") ON DELETE RESTRICT,
  "step" "external_write_step" NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The row as read again, the new row's id, or what went wrong.
  "detail" jsonb,
  PRIMARY KEY ("write_id", "step")
);--> statement-breakpoint
REVOKE UPDATE, DELETE ON "external_writes" FROM PUBLIC;--> statement-breakpoint
REVOKE UPDATE, DELETE ON "external_write_steps" FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER enforce_external_write_immutability
  BEFORE UPDATE OR DELETE ON external_writes
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_tampering();--> statement-breakpoint
CREATE TRIGGER enforce_external_write_step_immutability
  BEFORE UPDATE OR DELETE ON external_write_steps
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_tampering();
