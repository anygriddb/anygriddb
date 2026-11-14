-- A token that writes may be kept from deleting rows (ADR 0079). The
-- tokens made before keep deleting.
ALTER TABLE "api_tokens"
  ADD COLUMN "allow_delete" boolean NOT NULL DEFAULT true;
