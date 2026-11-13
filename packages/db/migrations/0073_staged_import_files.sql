-- An import is staged as the file people sent, read again by its job as
-- it goes (ADR 0064), beside what the first pass found: its columns, the
-- line of its header, its delimiter, and how many rows it holds.
ALTER TABLE "staged_uploads" ADD COLUMN "meta" jsonb;

-- Imports staged before held their rows, parsed, instead of the file:
-- their job could not read them. They would expire within two hours; the
-- orphan sweep removes their bytes, and a job waiting on one says to drop
-- the file again.
DELETE FROM "staged_uploads" WHERE "kind" = 'import';
