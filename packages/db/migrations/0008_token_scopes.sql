ALTER TABLE "api_tokens" ADD COLUMN "base_ids" jsonb;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "read_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "last_used_at" timestamp with time zone;