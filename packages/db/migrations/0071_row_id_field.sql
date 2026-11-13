-- A field that shows the row's own id (ADR 0063): the one the API, webhooks
-- and links name the row by. It reads the row's key and stores nothing.
ALTER TYPE "public"."field_type" ADD VALUE 'row_id';
