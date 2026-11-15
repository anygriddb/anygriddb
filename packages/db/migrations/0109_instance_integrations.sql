-- Notification and observability channels an administrator configures
-- (ADR 0092). Secrets are sealed in one column; config holds only what
-- may be shown again. Events are jsonb, not a text array: the database
-- client sends a JavaScript array as JSON.
CREATE TABLE "instance_integrations" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "provider" text NOT NULL,
  "name" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "secrets_ciphertext" bytea,
  "secrets_nonce" bytea,
  "events" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "last_delivery_at" timestamp with time zone,
  "last_error" text,
  "rate_window_started_at" timestamp with time zone,
  "rate_sent" integer DEFAULT 0 NOT NULL,
  "suppressed_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid,
  CONSTRAINT "instance_integrations_name_length" CHECK (char_length("name") BETWEEN 1 AND 80),
  CONSTRAINT "instance_integrations_status" CHECK ("status" IN ('active', 'error', 'disabled')),
  CONSTRAINT "instance_integrations_failures" CHECK ("consecutive_failures" >= 0),
  CONSTRAINT "instance_integrations_rate" CHECK ("rate_sent" >= 0 AND "suppressed_count" >= 0),
  CONSTRAINT "instance_integrations_secrets_pair" CHECK (("secrets_ciphertext" IS NULL) = ("secrets_nonce" IS NULL)),
  CONSTRAINT "instance_integrations_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL
);--> statement-breakpoint
CREATE INDEX "instance_integrations_provider" ON "instance_integrations" ("provider");--> statement-breakpoint
CREATE INDEX "instance_integrations_updated_by" ON "instance_integrations" ("updated_by");--> statement-breakpoint
-- One row for the probes that configure the process, not a list of channels.
CREATE UNIQUE INDEX "instance_integrations_singleton" ON "instance_integrations" ("provider")
  WHERE "provider" IN ('metrics', 'sentry', 'otlp');--> statement-breakpoint
CREATE TABLE "integration_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "integration_id" uuid NOT NULL,
  "event_id" uuid NOT NULL,
  "event" text NOT NULL,
  "subject" text DEFAULT '' NOT NULL,
  "fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "response_status" integer,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "integration_deliveries_status" CHECK ("status" IN ('pending', 'success', 'failed')),
  CONSTRAINT "integration_deliveries_attempts" CHECK ("attempts" >= 0),
  CONSTRAINT "integration_deliveries_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "instance_integrations"("id") ON DELETE CASCADE
);--> statement-breakpoint
-- One event is delivered once to a channel, even if it is emitted twice.
CREATE UNIQUE INDEX "integration_deliveries_once" ON "integration_deliveries" ("integration_id", "event_id");--> statement-breakpoint
CREATE INDEX "integration_deliveries_recent" ON "integration_deliveries" ("integration_id", "created_at" DESC);--> statement-breakpoint
CREATE TABLE "integration_schedules" (
  "integration_id" uuid NOT NULL,
  "schedule" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("integration_id", "schedule"),
  CONSTRAINT "integration_schedules_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "instance_integrations"("id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "integration_schedules_schedule" ON "integration_schedules" ("schedule");
-- rollback:
-- DROP TABLE "integration_schedules";
-- DROP TABLE "integration_deliveries";
-- DROP TABLE "instance_integrations";
