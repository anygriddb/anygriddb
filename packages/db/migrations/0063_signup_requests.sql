-- A sign-up whose address is not proved yet (ADR 0058). No account exists
-- until the link mailed to the address is opened and the password chosen
-- at sign-up is given again: whatever is given or joined to an account by
-- its address (administration, a role, a single sign-on identity) then
-- reaches only the person who reads that mailbox.
CREATE TABLE signup_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  -- Argon2id, as password_hashes; the link's SHA-256 only.
  password_hash text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Requests are counted per address, and all of an address's go once its
-- account exists.
CREATE INDEX signup_requests_email_idx ON signup_requests (email);
