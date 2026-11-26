-- A field that shows a row's state in its table's circuit (ADR 0133): it
-- reads the system column `ag_status`, as a created time reads
-- `ag_created_at`, and owns no column of its own.
ALTER TYPE "public"."field_type" ADD VALUE 'row_state';
