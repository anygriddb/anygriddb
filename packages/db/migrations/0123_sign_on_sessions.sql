-- A session, and a sign-in waiting for its second step, remember the provider
-- that vouched for them: which protocol, the provider's own session (as a
-- hash), and the moment the provider said it ends. A session with none of
-- them was opened with a password. A first binding to an account with a factor
-- of its own waits on the sign-in until that factor is proved: nothing is
-- written to `sso_identities` before.
ALTER TABLE "sessions"
  ADD COLUMN "sign_on" text CHECK ("sign_on" IN ('oidc', 'saml')),
  ADD COLUMN "sign_on_sid" text,
  ADD COLUMN "must_end_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "login_challenges"
  ADD COLUMN "sign_on" text CHECK ("sign_on" IN ('oidc', 'saml')),
  ADD COLUMN "sign_on_sid" text,
  ADD COLUMN "must_end_at" timestamp with time zone,
  ADD COLUMN "bind_issuer" text,
  ADD COLUMN "bind_subject" text,
  ADD CONSTRAINT "login_challenges_binding_whole" CHECK (
    ("bind_issuer" IS NULL) = ("bind_subject" IS NULL)
    AND ("bind_subject" IS NULL OR "sign_on" IS NOT NULL)
  );--> statement-breakpoint
CREATE INDEX "sessions_sign_on_sid" ON "sessions" ("sign_on_sid") WHERE "sign_on_sid" IS NOT NULL;
