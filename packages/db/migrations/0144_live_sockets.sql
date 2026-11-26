-- The live connections of each account, counted where every process of an
-- instance sees them (ADR 0132, family 3): one row a process and an account,
-- with how many sockets that process holds open for it. A process renews its
-- rows while it lives; one that stops renewing them is no longer counted.
-- Unlogged: a crash empties it, as it ends every socket.
CREATE UNLOGGED TABLE "live_sockets" (
  "process_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "open" integer NOT NULL CHECK ("open" > 0),
  "seen_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("process_id", "user_id")
);

CREATE INDEX "live_sockets_user" ON "live_sockets" ("user_id");
