-- Requests counted where every process of an instance sees them (ADR
-- 0132): one row a key (a client's address and the kind of request) and a
-- window of one minute. Unlogged: a crash empties it, which forgives a
-- minute of counting, and a count is no record to replay or copy.
CREATE UNLOGGED TABLE "rate_windows" (
  "key" text NOT NULL CHECK (char_length("key") <= 200),
  "window_start" timestamptz NOT NULL,
  "hits" integer NOT NULL CHECK ("hits" > 0),
  PRIMARY KEY ("key", "window_start")
);
