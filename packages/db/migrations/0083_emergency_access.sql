-- Emergency access (ADR 0074): an administrator reads a base they are not
-- a member of, for a time, with a reason its owners are told. A row is
-- one opening: it stops counting once it expires or is ended. What stays
-- for good is on the change trail (`access`): who opened which base, why,
-- and until when.
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'access';
ALTER TYPE "public"."notification_kind" ADD VALUE IF NOT EXISTS 'admin_access';

CREATE TABLE "emergency_access" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "base_id" uuid NOT NULL REFERENCES "bases"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "reason" text NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone
);

-- What each request of an administrator asks: the bases they have open.
CREATE INDEX "emergency_access_open"
  ON "emergency_access" ("user_id", "expires_at")
  WHERE "ended_at" IS NULL;

-- What a base's page asks: who has it open.
CREATE INDEX "emergency_access_base" ON "emergency_access" ("base_id");
