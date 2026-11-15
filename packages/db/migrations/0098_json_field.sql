-- A field type (ROADMAP #97): a JSON document, an object or a list, kept
-- as jsonb in the row's table. No column changes here.
ALTER TYPE "public"."field_type" ADD VALUE IF NOT EXISTS 'json';
