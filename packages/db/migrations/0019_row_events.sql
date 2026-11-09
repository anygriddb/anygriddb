-- Row events are queued in the transaction of the write (ADR 0008). The
-- event task reads the audit entries of that transaction, so each entry
-- records it. Older entries keep no transaction id.
ALTER TABLE "audit_events" ADD COLUMN "xact_id" xid8;--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "xact_id" SET DEFAULT pg_current_xact_id();--> statement-breakpoint
CREATE INDEX "audit_events_xact_idx" ON "audit_events" ("xact_id") WHERE "xact_id" IS NOT NULL;
