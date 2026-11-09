-- Every table has a storage (ADR 0002): a physical table in this database,
-- or a table or view in a client's database reached through a source.
-- Only native tables exist until sources come (phase 5).
CREATE TYPE "table_storage" AS ENUM ('native', 'external');--> statement-breakpoint
ALTER TABLE "data_tables" ADD COLUMN "storage" "table_storage" NOT NULL DEFAULT 'native';
