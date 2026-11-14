-- Administration shows the change trail newest first. The index made for
-- that (0003) is ordered NULLS LAST while the page asks for the default
-- order, so PostgreSQL could never walk it: it read every event and
-- sorted them to show fifty. The same index, in the order asked.
DROP INDEX "audit_events_occurred_at";
CREATE INDEX "audit_events_recent_idx" ON "audit_events" ("occurred_at" DESC);

-- The trail of one account, and an account's erasure, which rewrites the
-- author of its events: without this each read the whole trail, and an
-- erasure on a long trail could outlast the limit of a statement.
CREATE INDEX "audit_events_user_recent_idx"
  ON "audit_events" ("user_id", "occurred_at" DESC);
