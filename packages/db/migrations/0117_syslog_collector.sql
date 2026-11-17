-- The syslog collector set in Administration (ADR 0105): where the events
-- of the sign-in trail go as syslog over TLS, when the environment names
-- no collector. A certificate authority is no secret: it is kept as text.
CREATE TABLE "public"."instance_syslog" (
  "id" boolean PRIMARY KEY DEFAULT true,
  "host" text NOT NULL,
  "port" integer NOT NULL CHECK ("port" BETWEEN 1 AND 65535),
  "ca" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES "public"."users" ("id") ON DELETE SET NULL,
  CONSTRAINT "instance_syslog_singleton" CHECK ("id")
);
