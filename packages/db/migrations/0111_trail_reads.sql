-- Who opened a table, on the change trail (ROADMAP #31): off until a
-- manager turns it on for that table. Without this, every page open of
-- every table would write an event.
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'open';--> statement-breakpoint
ALTER TABLE "data_tables"
  ADD COLUMN "trail_reads" boolean DEFAULT false NOT NULL;
