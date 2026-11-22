-- How fast one automation runs. A run past its limit waits for a minute of
-- its own instead of being dropped: `reserved_minute` and `reserved` say how
-- far ahead the waiting runs have been given a place, `started_minute` and
-- `started` how many really started in the current minute, so that several
-- processes hold one limit. One row an automation, updated in one statement.
CREATE TABLE "automation_run_pace" (
  "automation_id" uuid PRIMARY KEY
    REFERENCES "automations" ("id") ON DELETE CASCADE,
  "started_minute" timestamp with time zone NOT NULL,
  "started" integer NOT NULL CHECK ("started" >= 0),
  "reserved_minute" timestamp with time zone NOT NULL,
  "reserved" integer NOT NULL CHECK ("reserved" >= 0),
  "dropped_told_at" timestamp with time zone
);
