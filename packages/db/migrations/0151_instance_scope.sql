-- Administration's roles become attributions at the instance (ADR 0131).
-- A value an enum gains cannot be used in the transaction that adds it:
-- this migration adds it alone, and the next one uses it.
ALTER TYPE "scope" ADD VALUE IF NOT EXISTS 'instance';
