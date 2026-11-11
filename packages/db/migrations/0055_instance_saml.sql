-- Operator SAML (ADR 0050): one row; IdP certificate as PEM text. ACS URL
-- is derived from PUBLIC_URL at resolve time.
CREATE TABLE "instance_saml" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL CHECK ("id"),
  "entry_point" text NOT NULL CHECK (length("entry_point") BETWEEN 1 AND 2048),
  "issuer" text NOT NULL CHECK (length("issuer") BETWEEN 1 AND 1024),
  "idp_cert" text NOT NULL CHECK (length("idp_cert") BETWEEN 1 AND 16384),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
