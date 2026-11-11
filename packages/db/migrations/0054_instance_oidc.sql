-- Operator OIDC (ADR 0050): one row; client secret sealed. Redirect URL is
-- derived from PUBLIC_URL at resolve time.
CREATE TABLE "instance_oidc" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL CHECK ("id"),
  "issuer" text NOT NULL CHECK (length("issuer") BETWEEN 1 AND 2048),
  "client_id" text NOT NULL CHECK (length("client_id") BETWEEN 1 AND 512),
  "client_secret_ciphertext" bytea NOT NULL,
  "client_secret_nonce" bytea NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
