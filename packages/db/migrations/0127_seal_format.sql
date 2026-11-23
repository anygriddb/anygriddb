-- A seal names the format of the reading that made it (ADR 0118). A row
-- sealed before keeps its values and its fingerprint: it is compared by the
-- reading of its format, then sealed again in the current one, with an entry
-- in its trail. Nothing already recorded is rewritten.
ALTER TABLE "external_statuses" ADD COLUMN "seal_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "external_statuses" ALTER COLUMN "seal_format" SET DEFAULT 2;--> statement-breakpoint
ALTER TABLE "external_statuses" ADD CONSTRAINT "external_statuses_seal_format" CHECK ("seal_format" IN (1, 2));--> statement-breakpoint
ALTER TABLE "external_status_events" DROP CONSTRAINT "external_status_events_action_check";--> statement-breakpoint
ALTER TABLE "external_status_events" ADD CONSTRAINT "external_status_events_action_check"
  CHECK ("action" IN ('submit', 'lock', 'unlock', 'sign', 'changed', 'restored', 'resealed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "external_status_events" VALIDATE CONSTRAINT "external_status_events_action_check";
