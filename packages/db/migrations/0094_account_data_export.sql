-- An account's data exported as a file (ROADMAP #32): the job that writes
-- it, and the event the sign-in trail keeps of it.
ALTER TYPE "public"."job_kind" ADD VALUE IF NOT EXISTS 'account_export';--> statement-breakpoint
ALTER TYPE "public"."auth_action" ADD VALUE IF NOT EXISTS 'account_data_exported';--> statement-breakpoint

-- The events an account made on other accounts, and the comments it
-- wrote: the export reads them, and an account's erasure rewrites them.
-- Without these, each read the whole table.
CREATE INDEX "auth_events_actor_idx"
  ON "auth_events" ("actor_id", "occurred_at" DESC)
  WHERE "actor_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "comments_author_idx"
  ON "comments" ("author_id", "created_at" DESC);
