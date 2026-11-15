-- A thread of comments is resolved, and opened again: when, and by whom.
-- The resolver's deletion leaves the thread resolved and forgets who did.
ALTER TABLE "comments" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "resolved_by" uuid
  REFERENCES "public"."users" ("id") ON DELETE SET NULL;
