-- A purge reserves what it destroys before it destroys anything, in a
-- transaction of its own, and a restore requires no reservation: of a purge
-- and a restore of one item, exactly one wins. The mark outlives a stopped
-- process, so that the next pass finishes what was started.
SELECT set_config('anygrid.migrate', 'on', true);--> statement-breakpoint
ALTER TABLE "bases" ADD COLUMN "purge_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_tables" ADD COLUMN "purge_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_columns" ADD COLUMN "purge_started_at" timestamp with time zone;
