-- An administrator who registered an application can be deleted like any
-- other account (ADR 0051): the application stays, without its author.
-- The reference refused the delete.
ALTER TABLE "oauth_clients"
  ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "oauth_clients"
  DROP CONSTRAINT "oauth_clients_created_by_users_id_fk";--> statement-breakpoint

ALTER TABLE "oauth_clients"
  ADD CONSTRAINT "oauth_clients_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Identifiers ordered by time, as every other table's are (ADR 0003).
ALTER TABLE "oauth_clients"
  ALTER COLUMN "id" SET DEFAULT ag_uuidv7();--> statement-breakpoint

ALTER TABLE "oauth_authorization_codes"
  ALTER COLUMN "id" SET DEFAULT ag_uuidv7();--> statement-breakpoint

ALTER TABLE "oauth_refresh_tokens"
  ALTER COLUMN "id" SET DEFAULT ag_uuidv7();--> statement-breakpoint

-- Each token revoked or refreshed removes its refresh token through this
-- reference, and revoking an application removes its tokens by this column.
CREATE INDEX "oauth_refresh_tokens_api_token"
  ON "oauth_refresh_tokens" ("api_token_id");--> statement-breakpoint

CREATE INDEX "api_tokens_oauth_client"
  ON "api_tokens" ("oauth_client_id")
  WHERE "oauth_client_id" IS NOT NULL;
