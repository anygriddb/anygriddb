-- An export kept on the change trail (ROADMAP #31): who took what out,
-- by its kind, format, and number of rows. Never a value.
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'export';
