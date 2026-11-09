-- A failed job keeps the code and detail of its error (ADR 0013), so the
-- app translates it like any other; `error` stays the English message.
ALTER TABLE "jobs"
  ADD COLUMN "error_code" text,
  ADD COLUMN "error_detail" text;
