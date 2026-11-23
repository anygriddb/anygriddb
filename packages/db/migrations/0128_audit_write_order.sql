-- The date of an event is when its transaction began, so two writes to one
-- row that overlap can carry their dates in the opposite order to the one
-- they were written in. A number taken as the event is written, while the
-- write holds the row's lock, gives a row's events their real order. Events
-- already kept have none: they stay behind the new ones, by their date. The
-- column is added first and given its default after, so that the trail,
-- the one table that grows without end, is not rewritten.
CREATE SEQUENCE "audit_events_write_order_seq";--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "write_order" bigint;--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "write_order" SET DEFAULT nextval('audit_events_write_order_seq');--> statement-breakpoint
ALTER SEQUENCE "audit_events_write_order_seq" OWNED BY "audit_events"."write_order";
