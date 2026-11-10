-- The identity a sign-on provider vouches for, by its own subject (OIDC
-- `sub`, a persistent SAML NameID). Once an account is bound to one, it is
-- found by it, whatever the address says, and another subject bringing the
-- same address is refused: an address alone no longer opens an account.
CREATE TABLE "sso_identities" (
  "provider" text NOT NULL CHECK ("provider" IN ('oidc', 'saml')),
  "issuer" text NOT NULL CHECK (length("issuer") BETWEEN 1 AND 1024),
  "subject" text NOT NULL CHECK (length("subject") BETWEEN 1 AND 1024),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("provider", "issuer", "subject"),
  CONSTRAINT "sso_identities_one_per_account" UNIQUE ("provider", "issuer", "user_id")
);--> statement-breakpoint
-- An administrator lets an account bind to another subject (an account
-- made again at the provider): told in the sign-in trail.
ALTER TYPE "public"."auth_action" ADD VALUE 'sso_unlinked';
