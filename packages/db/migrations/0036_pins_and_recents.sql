-- A person's own shortcuts: the bases and tables they pinned, and the
-- tables they opened last. Nobody else sees them, and they change nothing
-- anyone shares, so they are not audited. Reading them goes through the
-- catalog the person can see: a shortcut to a table they lost, or one in
-- the trash, is not shown.
CREATE TABLE "pins" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "base_id" uuid REFERENCES "bases"("id") ON DELETE CASCADE,
  "table_id" uuid REFERENCES "data_tables"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CHECK (num_nonnulls("base_id", "table_id") = 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX "pins_user_base" ON "pins" ("user_id", "base_id") WHERE "base_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pins_user_table" ON "pins" ("user_id", "table_id") WHERE "table_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE "recent_tables" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "table_id" uuid NOT NULL REFERENCES "data_tables"("id") ON DELETE CASCADE,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "table_id")
);--> statement-breakpoint
CREATE INDEX "recent_tables_user_opened" ON "recent_tables" ("user_id", "opened_at" DESC);
