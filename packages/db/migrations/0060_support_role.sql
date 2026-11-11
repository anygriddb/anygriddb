-- Support role (ADR 0054): helpdesk account operations without full admin.
ALTER TABLE "public"."users"
  ADD COLUMN "is_support" boolean DEFAULT false NOT NULL;
