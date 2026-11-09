-- Importing an Airtable base through Airtable's Web API, as a background
-- job its author follows. The personal access token is sealed in the
-- job's input and removed when the job ends.
ALTER TYPE "public"."job_kind" ADD VALUE 'import_airtable';
