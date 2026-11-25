-- One journal of what the instance delivers outside (ADR 0125, ROADMAP
-- #112): a table's webhooks and the instance's notification channels kept
-- two, with their own retries, sweep and purge, and an administrator saw
-- only the webhooks' failures. A delivery names the webhook or the channel
-- it goes to, never both; deleting either deletes its deliveries.
CREATE TABLE "deliveries" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "webhook_id" uuid REFERENCES "webhooks" ("id") ON DELETE CASCADE,
  "integration_id" uuid REFERENCES "instance_integrations" ("id") ON DELETE CASCADE,
  "origin" text GENERATED ALWAYS AS (
    CASE WHEN "webhook_id" IS NOT NULL THEN 'webhook' ELSE 'integration' END
  ) STORED,
  "event" text NOT NULL,
  -- A channel's event, delivered once to it even if it is emitted twice.
  "event_id" uuid,
  -- What the event is about, for a channel's quiet period.
  "subject" text DEFAULT '' NOT NULL,
  -- A webhook's row: a client table's key is text.
  "row_id" text,
  -- What is sent: a webhook's body, a channel's fields. A webhook's is
  -- removed once delivered.
  "payload" jsonb,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "response_status" integer,
  "error" text,
  "next_attempt_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "deliveries_one_origin"
    CHECK (num_nonnulls("webhook_id", "integration_id") = 1),
  CONSTRAINT "deliveries_status"
    CHECK ("status" IN ('pending', 'success', 'failed')),
  CONSTRAINT "deliveries_attempts" CHECK ("attempts" >= 0)
);

INSERT INTO "deliveries" (
  "id", "webhook_id", "event", "row_id", "payload", "status", "attempts",
  "response_status", "error", "next_attempt_at", "created_at", "finished_at"
)
SELECT
  "id", "webhook_id", "event", "row_id", "payload", "status"::text,
  "attempts", "response_status", "error", "next_attempt_at", "created_at",
  "finished_at"
FROM "webhook_deliveries";

INSERT INTO "deliveries" (
  "id", "integration_id", "event", "event_id", "subject", "payload",
  "status", "attempts", "response_status", "error", "created_at",
  "finished_at"
)
SELECT
  "id", "integration_id", "event", "event_id", "subject", "fields",
  "status", "attempts", "response_status", "error", "created_at",
  "finished_at"
FROM "integration_deliveries";

CREATE UNIQUE INDEX "deliveries_event_once"
  ON "deliveries" ("integration_id", "event_id")
  WHERE "integration_id" IS NOT NULL;
CREATE INDEX "deliveries_webhook"
  ON "deliveries" ("webhook_id", "created_at" DESC)
  WHERE "webhook_id" IS NOT NULL;
CREATE INDEX "deliveries_integration"
  ON "deliveries" ("integration_id", "created_at" DESC)
  WHERE "integration_id" IS NOT NULL;
-- The sweep reads the pending ones whose attempt is late.
CREATE INDEX "deliveries_pending"
  ON "deliveries" ("next_attempt_at")
  WHERE "status" = 'pending';
-- Administration lists the failures, newest first, and the alerts count
-- the day's; the purge reads by age.
CREATE INDEX "deliveries_failed"
  ON "deliveries" ("created_at" DESC)
  WHERE "status" = 'failed';
CREATE INDEX "deliveries_created" ON "deliveries" ("created_at");

DROP TABLE "webhook_deliveries";
DROP TABLE "integration_deliveries";
DROP TYPE "delivery_status";
