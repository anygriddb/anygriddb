-- Tables and views of a client's database exposed in a base (ADR 0006).
-- Their rows stay in the client's database: the catalog records where.
ALTER TABLE "data_tables"
  ADD COLUMN "source_id" uuid REFERENCES "sources"("id") ON DELETE RESTRICT,
  ADD COLUMN "external_schema" text,
  ADD COLUMN "external_name" text,
  -- The primary key's columns, as stored, in a JSON array; empty for a
  -- view without one.
  ADD COLUMN "external_key" jsonb;--> statement-breakpoint
ALTER TABLE "data_tables" ADD CONSTRAINT "data_tables_external" CHECK (
  ("storage" = 'external') = (
    "source_id" IS NOT NULL
    AND "external_schema" IS NOT NULL
    AND "external_name" IS NOT NULL
    AND coalesce(jsonb_typeof("external_key") = 'array', false)
  )
);--> statement-breakpoint
-- A client table shows once per base.
CREATE UNIQUE INDEX "data_tables_external_once" ON "data_tables"
  ("base_id", "source_id", "external_schema", "external_name")
  WHERE "source_id" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint
-- A client column keeps its name in physical_name, and its type here.
ALTER TABLE "data_columns" ADD COLUMN "external_type" text;--> statement-breakpoint
-- Comments and their notifications name a client's row by its key, as
-- text (ADR 0006): they live here, never in the client's database.
ALTER TABLE "comments" ALTER COLUMN "row_id" TYPE text;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "row_id" TYPE text;
