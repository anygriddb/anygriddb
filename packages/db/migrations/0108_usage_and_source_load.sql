-- Usage figures for administrators (ROADMAP #40): one row a day, so a
-- trend does not depend on who is active now. Load by source (#41): every
-- process writes minute buckets; Administration reads those, never the
-- in-memory Prometheus counters.
CREATE TABLE "usage_daily" (
  "day" date PRIMARY KEY,
  "accounts_active_30d" integer NOT NULL,
  "bases_active_30d" integer NOT NULL,
  "accounts_total" integer NOT NULL,
  "bases_total" integer NOT NULL
);--> statement-breakpoint
CREATE TABLE "source_load_minute" (
  "source_id" uuid NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
  "minute" timestamp with time zone NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('read', 'write')),
  "ops" integer DEFAULT 0 NOT NULL,
  "errors" integer DEFAULT 0 NOT NULL,
  "timeouts" integer DEFAULT 0 NOT NULL,
  "slow" integer DEFAULT 0 NOT NULL,
  "total_ms" bigint DEFAULT 0 NOT NULL,
  PRIMARY KEY ("source_id", "minute", "kind")
);--> statement-breakpoint
CREATE INDEX "source_load_minute_minute" ON "source_load_minute" ("minute" DESC);
