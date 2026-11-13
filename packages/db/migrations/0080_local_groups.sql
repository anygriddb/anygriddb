-- Local groups (ADR 0070): an administrator makes a group by hand in
-- Administration. The same table holds groups an identity provider keeps
-- through SCIM (ADR 0038). A null provider means the group is local; "scim"
-- means the provider owns its membership. Existing rows came from SCIM.
ALTER TABLE "groups" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "description" text;--> statement-breakpoint
UPDATE "groups" SET "provider" = 'scim' WHERE "provider" IS NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_provider_check"
  CHECK ("provider" IS NULL OR "provider" = 'scim');
