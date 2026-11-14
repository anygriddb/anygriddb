-- The instance's logo (ADR 0072): one row, the image itself. It is part of
-- how the instance is set up, as its settings are, so it lives with them
-- and travels in the database's backup. `version` names these bytes: the
-- address pages load the image from carries it, so a browser keeps the
-- image until it changes.
CREATE TABLE "instance_logo" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL CHECK ("id"),
  "content_type" text NOT NULL CHECK (
    "content_type" IN ('image/png', 'image/jpeg', 'image/webp')
  ),
  "bytes" bytea NOT NULL CHECK (octet_length("bytes") BETWEEN 1 AND 262144),
  "version" text NOT NULL CHECK ("version" ~ '^[0-9a-f]{16}$'),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
