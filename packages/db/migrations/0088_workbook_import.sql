-- A workbook made a base (ROADMAP row 100, ADR 0078): an `.xlsx` file is
-- staged with what its first pass found in each worksheet, then a job of
-- its own makes a table of each chosen sheet.
ALTER TYPE "public"."job_kind" ADD VALUE IF NOT EXISTS 'import_workbook';

ALTER TABLE "staged_uploads" DROP CONSTRAINT "staged_uploads_kind_check";
ALTER TABLE "staged_uploads" ADD CONSTRAINT "staged_uploads_kind_check"
  CHECK ("kind" IN ('import', 'snapshot', 'workbook'));
