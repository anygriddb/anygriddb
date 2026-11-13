-- The backups an operator's script reports (ROADMAP #17), and the alerts
-- open for administrators (#25). Metadata only: never a cell value.
CREATE TABLE "backup_runs" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone DEFAULT now() NOT NULL,
  "succeeded" boolean NOT NULL,
  -- What the backup weighs, when its script could tell.
  "bytes" bigint,
  "encrypted" boolean DEFAULT false NOT NULL,
  -- The name the operator knows it by: its folder.
  "name" text NOT NULL
);--> statement-breakpoint
CREATE INDEX "backup_runs_finished_at" ON "backup_runs" ("finished_at" DESC);--> statement-breakpoint
CREATE TABLE "instance_alerts" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "kind" text NOT NULL CHECK (
    "kind" IN (
      'backup_late',
      'backup_failed',
      'storage_full',
      'certificate_expiring',
      'source_unreachable',
      'failures'
    )
  ),
  -- What it is about within its kind: a source's id, or nothing.
  "subject" text DEFAULT '' NOT NULL,
  "detail" jsonb DEFAULT '{}' NOT NULL,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- When administrators were last mailed about it.
  "notified_at" timestamp with time zone,
  "closed_at" timestamp with time zone
);--> statement-breakpoint
-- One open alert per kind and subject.
CREATE UNIQUE INDEX "instance_alerts_open"
  ON "instance_alerts" ("kind", "subject")
  WHERE "closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "instance_alerts_closed_at" ON "instance_alerts" ("closed_at")
  WHERE "closed_at" IS NOT NULL;
