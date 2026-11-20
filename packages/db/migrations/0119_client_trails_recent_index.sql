-- Administration says when each base was last used: the newest event of
-- each of its tables. The change trail gives a table's newest event in one
-- probe (0068). The two trails of the tables kept in a client's database
-- had no index by table and time: PostgreSQL walked the writes of every
-- table back in time until it met one of the table asked, and for a table
-- never written it walked them all. At a million writes and 200,000
-- statuses over the forty tables of one base, reading when that base was
-- last used took 86 ms; 0.2 ms with these two indexes. The first weighs
-- 33 MB beside 142 MB of writes.
CREATE INDEX "external_writes_table_recent_idx"
  ON "external_writes" ("table_id", "requested_at" DESC);

-- A status a person gave a client's row. What a check found on a locked
-- row has no author: it is nobody's use of the table, and stays out.
CREATE INDEX "external_status_events_table_recent_idx"
  ON "external_status_events" ("table_id", "at" DESC)
  WHERE "user_id" IS NOT NULL;
