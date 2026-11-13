-- The home page says when each table the person opened last changed, and
-- who changed it: the newest event of a table is one probe of this index,
-- however long the trail has grown.
CREATE INDEX audit_events_table_recent_idx ON audit_events (table_id, occurred_at DESC);
