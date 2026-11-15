-- Applications that ask a person for access (ROADMAP #101, ADR 0094):
-- an administrator registers the client; the person consents on chosen
-- bases; the grant is a normal api_tokens row.
ALTER TABLE "api_tokens"
  ADD COLUMN "oauth_client_id" uuid;--> statement-breakpoint

CREATE TABLE "oauth_clients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" text NOT NULL,
  "name" text NOT NULL,
  "secret_hash" text NOT NULL,
  "redirect_uris" text[] NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone
);--> statement-breakpoint

CREATE UNIQUE INDEX "oauth_clients_client_id" ON "oauth_clients" ("client_id");--> statement-breakpoint

ALTER TABLE "oauth_clients"
  ADD CONSTRAINT "oauth_clients_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "api_tokens"
  ADD CONSTRAINT "api_tokens_oauth_client_id_oauth_clients_id_fk"
  FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "oauth_authorization_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code_hash" text NOT NULL,
  "client_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "redirect_uri" text NOT NULL,
  "code_challenge" text NOT NULL,
  "code_challenge_method" text NOT NULL
    CHECK ("code_challenge_method" IN ('S256')),
  "base_ids" uuid[] NOT NULL,
  "read_only" boolean DEFAULT false NOT NULL,
  "allow_delete" boolean DEFAULT true NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX "oauth_authorization_codes_hash"
  ON "oauth_authorization_codes" ("code_hash");--> statement-breakpoint

ALTER TABLE "oauth_authorization_codes"
  ADD CONSTRAINT "oauth_authorization_codes_client_id_fk"
  FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "oauth_authorization_codes"
  ADD CONSTRAINT "oauth_authorization_codes_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "oauth_refresh_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_hash" text NOT NULL,
  "client_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "api_token_id" uuid NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX "oauth_refresh_tokens_hash"
  ON "oauth_refresh_tokens" ("token_hash");--> statement-breakpoint

ALTER TABLE "oauth_refresh_tokens"
  ADD CONSTRAINT "oauth_refresh_tokens_client_id_fk"
  FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "oauth_refresh_tokens"
  ADD CONSTRAINT "oauth_refresh_tokens_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "oauth_refresh_tokens"
  ADD CONSTRAINT "oauth_refresh_tokens_api_token_id_fk"
  FOREIGN KEY ("api_token_id") REFERENCES "public"."api_tokens"("id")
  ON DELETE cascade ON UPDATE no action;
