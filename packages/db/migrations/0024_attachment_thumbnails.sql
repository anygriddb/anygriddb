-- The orphan file sweep looks thumbnails up by key.
CREATE INDEX "attachments_thumb_key_idx" ON "attachments" ("thumb_key")
  WHERE "thumb_key" IS NOT NULL;
