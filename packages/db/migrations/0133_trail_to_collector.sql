-- The change trail leaves a copy where the database cannot reach it (ADR
-- 0120): each event's fingerprint goes to the instance's collectors, in
-- numbered batches that each carry the digest of the one before. This row
-- says how far that went: the last event sent, by its write order, the
-- last batch, and the point the next batches may reach once every
-- transaction that could still write below it has ended.
CREATE TABLE "trail_shipping" (
  "id" boolean PRIMARY KEY DEFAULT true CHECK ("id"),
  "shipped_order" bigint NOT NULL,
  "batch" bigint NOT NULL DEFAULT 0,
  "digest" text,
  "horizon_order" bigint,
  "horizon_xact" xid8,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "shipped_at" timestamptz,
  "failed_at" timestamptz
);--> statement-breakpoint
-- The events in the order they were written. A long trail gets this index
-- beside the writes, after the start (`anygriddb database indexes`): built
-- here, it would hold every write until it ends. A short one gets it now.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit_events OFFSET 100000 LIMIT 1) THEN
    CREATE INDEX IF NOT EXISTS "audit_events_write_order"
      ON "audit_events" ("write_order") WHERE "write_order" IS NOT NULL;
  END IF;
END $$;
