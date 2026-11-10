-- Optional read replica per source (ADR 0006): grid and API reads may use
-- it; writes, sync DDL, and enrichment stay on the primary. Same engine
-- and credentials when the replica columns for user/password are null.
ALTER TABLE "sources"
  ADD COLUMN "replica_host" text,
  ADD COLUMN "replica_port" integer
    CHECK ("replica_port" IS NULL OR ("replica_port" >= 1 AND "replica_port" <= 65535)),
  ADD COLUMN "replica_database" text,
  ADD COLUMN "replica_username" text,
  ADD COLUMN "replica_password_ciphertext" bytea,
  ADD COLUMN "replica_password_nonce" bytea,
  ADD COLUMN "replica_checked_at" timestamp with time zone,
  ADD COLUMN "replica_server_version" text;--> statement-breakpoint
