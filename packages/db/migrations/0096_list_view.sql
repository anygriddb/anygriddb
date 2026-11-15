-- A list view (ROADMAP #96): the rows one under another, each under the
-- row a link to the same table names.
ALTER TYPE "public"."view_type" ADD VALUE IF NOT EXISTS 'list';
