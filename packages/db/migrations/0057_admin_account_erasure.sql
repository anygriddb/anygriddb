-- Admin-initiated account erasure (ADR 0051): comments keep their bodies
-- under the tombstone account, like the audit trail, instead of cascading
-- away with the person. The sign-in trail records that an administrator
-- erased an account.
ALTER TABLE "comments" DROP CONSTRAINT "comments_author_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk"
  FOREIGN KEY ("author_id") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TYPE "public"."auth_action" ADD VALUE 'account_erased';
