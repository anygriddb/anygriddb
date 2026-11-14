-- A whole base shared read-only by one link (ROADMAP row 93): a share
-- names a view, or a base, never both. A base's link goes with its base.
ALTER TABLE "shares" ALTER COLUMN "view_id" DROP NOT NULL;
ALTER TABLE "shares"
  ADD COLUMN "base_id" uuid REFERENCES "bases" ("id") ON DELETE CASCADE;
ALTER TABLE "shares" ADD CONSTRAINT "shares_view_or_base_check"
  CHECK (("view_id" IS NULL) <> ("base_id" IS NULL));
CREATE INDEX "shares_base_idx" ON "shares" ("base_id")
  WHERE "base_id" IS NOT NULL;
