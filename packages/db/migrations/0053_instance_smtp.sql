-- Operator SMTP (ADR 0050): one row, password sealed with AUTH_ENCRYPTION_KEY.
CREATE TABLE "instance_smtp" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL CHECK ("id"),
  "host" text NOT NULL CHECK (length("host") BETWEEN 1 AND 253),
  "port" integer NOT NULL DEFAULT 587 CHECK ("port" BETWEEN 1 AND 65535),
  "username" text CHECK ("username" IS NULL OR length("username") BETWEEN 1 AND 320),
  "from_address" text NOT NULL CHECK (length("from_address") BETWEEN 3 AND 320),
  "password_ciphertext" bytea,
  "password_nonce" bytea,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "instance_smtp_password_pair" CHECK (
    ("password_ciphertext" IS NULL AND "password_nonce" IS NULL)
    OR ("password_ciphertext" IS NOT NULL AND "password_nonce" IS NOT NULL)
  )
);
