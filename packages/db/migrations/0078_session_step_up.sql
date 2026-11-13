-- When a session last proved who holds it (ROADMAP #28): a sensitive
-- Administration action asks for the password or the second factor
-- again, unless one was given less than five minutes ago.
ALTER TABLE "sessions"
  ADD COLUMN "stepped_up_at" timestamp with time zone;
