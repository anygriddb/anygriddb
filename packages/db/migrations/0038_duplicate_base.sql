-- A base copied in one step: its snapshot is built, then read into a new
-- base, in one background job.
ALTER TYPE "public"."job_kind" ADD VALUE 'duplicate_base';
