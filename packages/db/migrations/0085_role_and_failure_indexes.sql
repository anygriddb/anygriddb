-- Every request reads the roles of its account, and a base's page, its
-- members and its owners read the roles given on it. The table had no
-- index for either, so each of them read every role of the instance.
CREATE INDEX "role_bindings_user" ON "role_bindings" ("user_id");
CREATE INDEX "role_bindings_scope" ON "role_bindings" ("scope_id");

-- The alerts count the day's failed deliveries and runs every ten minutes.
-- Only the failures are indexed: the count reads nothing else, and the
-- indexes stay small however long the history kept.
CREATE INDEX "webhook_deliveries_failed"
  ON "webhook_deliveries" ("created_at")
  WHERE "status" = 'failed';
CREATE INDEX "automation_runs_failed"
  ON "automation_runs" ("started_at")
  WHERE "status" = 'failed';
