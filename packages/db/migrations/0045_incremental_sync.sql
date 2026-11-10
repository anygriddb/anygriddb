-- Incremental synced refresh (ADR 0034 follow-up): optional mode that
-- upserts rows changed since a watermark, with a periodic full reconcile
-- so deletes are still found.
ALTER TABLE "external_syncs"
  ADD COLUMN "sync_mode" text NOT NULL DEFAULT 'full'
    CHECK ("sync_mode" IN ('full', 'incremental')),
  ADD COLUMN "change_column" text,
  ADD COLUMN "watermark" text,
  ADD COLUMN "last_full_at" timestamp with time zone,
  ADD COLUMN "refresh_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "full_every" integer NOT NULL DEFAULT 24
    CHECK ("full_every" >= 1 AND "full_every" <= 10_080);--> statement-breakpoint
