-- Folders of tables in a base (ROADMAP #4): organisation in the sidebar
-- only. Access stays on the base and each table; a folder adds no role.
CREATE TABLE "table_folders" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "base_id" uuid NOT NULL REFERENCES "bases"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  "deleted_by" uuid REFERENCES "users"("id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "table_folders_base_name_live"
  ON "table_folders" ("base_id", "name")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "data_tables"
  ADD COLUMN "folder_id" uuid REFERENCES "table_folders"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX "data_tables_folder_live"
  ON "data_tables" ("folder_id")
  WHERE "folder_id" IS NOT NULL AND "deleted_at" IS NULL;
