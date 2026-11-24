-- The copy of the change trail covers the whole trail, and an event's place
-- in it is the database's to give (ADR 0121).
--
-- A role that does not own the trail took the write order and the
-- transaction its insert named: an event given an order below what was
-- already sent, or none, would never have left for the collectors. Its
-- order and transaction are now taken here, whatever the insert said. The
-- owner keeps what it writes: a restore brings each event's own.
CREATE FUNCTION audit_events_take_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT ag_role_owns_store(current_user) THEN
    NEW.write_order := nextval('audit_events_write_order_seq');
    NEW.xact_id := pg_current_xact_id();
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_events_take_order
  BEFORE INSERT ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION audit_events_take_order();--> statement-breakpoint
-- The events from before the write order (migration 0128) leave first,
-- oldest first: this is how far that went, and whether it is done.
ALTER TABLE "trail_shipping" ADD COLUMN "early_at" timestamptz;--> statement-breakpoint
ALTER TABLE "trail_shipping" ADD COLUMN "early_id" uuid;--> statement-breakpoint
ALTER TABLE "trail_shipping" ADD COLUMN "early_done" boolean NOT NULL DEFAULT false;--> statement-breakpoint
-- A copy turned on with 0.7.1 began at the newest event then: it sends the
-- whole trail again, in the same chain. An event may reach a collector
-- twice; none is missing.
UPDATE "trail_shipping" SET "shipped_order" = 0, "horizon_order" = NULL, "horizon_xact" = NULL;--> statement-breakpoint
-- Those early events in the order they were written, as an index of their
-- own: a short trail gets it here, a long one beside the writes, after the
-- start, as the write order's (`anygriddb database indexes`).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit_events OFFSET 100000 LIMIT 1) THEN
    CREATE INDEX IF NOT EXISTS "audit_events_early"
      ON "audit_events" ("occurred_at", "id") WHERE "write_order" IS NULL;
  END IF;
END $$;
