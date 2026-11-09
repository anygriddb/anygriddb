-- An uploaded file waiting for its job (ADR 0009): a parsed import until
-- the person confirms its mapping, or a snapshot until it is restored.
-- The bytes sit in the file store; this row says whose they are and until
-- when they are kept.
CREATE TABLE "staged_uploads" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7(),
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('import', 'snapshot')),
  "filename" text NOT NULL,
  "file_key" text NOT NULL UNIQUE,
  "size" integer NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "staged_uploads_expires_idx" ON "staged_uploads" ("expires_at");
