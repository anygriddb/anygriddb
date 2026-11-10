-- Fields AnyGridDB adds to a client's table when the DBA grants no side
-- schema: values live in the control plane, keyed by the client's row id
-- as text (same shape as external_statuses). Filter by key list; sort and
-- group on these fields are refused on live tables.
CREATE TABLE "external_enrichment_values" (
  "table_id" uuid NOT NULL REFERENCES "data_tables"("id") ON DELETE CASCADE,
  "row_id" text NOT NULL,
  -- Field id → stored JSON value (null clears the cell).
  "values" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  PRIMARY KEY ("table_id", "row_id")
);--> statement-breakpoint
CREATE INDEX "external_enrichment_values_gin"
  ON "external_enrichment_values" USING gin ("values");--> statement-breakpoint
