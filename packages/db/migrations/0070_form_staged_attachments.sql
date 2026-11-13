-- A file sent to a public form waits for the answer that carries it
-- (ADR 0062): until then it belongs to the form's link and has a
-- deadline. Writing the answer clears both in the row's own
-- transaction; a file never claimed is removed after its deadline. A
-- file uploaded by a member has neither.
ALTER TABLE "attachments"
  ADD COLUMN "staged_share_id" uuid REFERENCES "shares" ("id") ON DELETE CASCADE,
  ADD COLUMN "staged_until" timestamp with time zone,
  ADD CONSTRAINT "attachments_staged_together"
    CHECK (("staged_share_id" IS NULL) = ("staged_until" IS NULL));

CREATE INDEX "attachments_staged_until" ON "attachments" ("staged_until")
  WHERE "staged_until" IS NOT NULL;

CREATE INDEX "attachments_staged_share" ON "attachments" ("staged_share_id")
  WHERE "staged_share_id" IS NOT NULL;
