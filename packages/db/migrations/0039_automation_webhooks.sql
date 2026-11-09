-- An automation started by a call to its own secret address (a webhook
-- trigger): only the token's SHA-256 is kept, so the address shows once.
ALTER TABLE "automations" ADD COLUMN "webhook_token_hash" text UNIQUE;
