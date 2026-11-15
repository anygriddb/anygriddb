-- Stores that speak no SQL (ADR 0088): AnyGridDB reads them from a copy
-- only. The first is a database that speaks the MongoDB wire protocol.
ALTER TYPE "public"."source_engine" ADD VALUE 'mongodb';--> statement-breakpoint
-- Values a refresh could not keep in their field's type: a store without a
-- schema may hold a text where a field's other rows hold a number. They
-- read empty, and the source's page says how many.
ALTER TABLE "external_syncs" ADD COLUMN "left_out" integer NOT NULL DEFAULT 0;
