-- The parts of a person's name, as their identity provider gave them. A
-- provider sends only the part that changed: with the display name alone
-- kept, a new given name replaced the whole name.
ALTER TABLE "users" ADD COLUMN "scim_given_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "scim_family_name" text;
