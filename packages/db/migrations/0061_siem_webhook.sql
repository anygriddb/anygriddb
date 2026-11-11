-- SIEM webhook (ADR 0056): optional HTTPS delivery of selected auth events.
CREATE TABLE "public"."instance_siem" (
  "id" boolean PRIMARY KEY DEFAULT true,
  "url" text NOT NULL,
  "secret_ciphertext" bytea NOT NULL,
  "secret_nonce" bytea NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES "public"."users" ("id") ON DELETE SET NULL,
  CONSTRAINT "instance_siem_singleton" CHECK ("id")
);
