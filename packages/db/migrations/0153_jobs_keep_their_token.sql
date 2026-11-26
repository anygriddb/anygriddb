-- A job a token started acts by that token (ADR 0131, §5): what the token
-- was given, within what its author holds when the job runs, and nothing
-- once the token is revoked or ends. The token is named on the job and
-- read again at each run; no key ties them, since a revoked token's row
-- goes and the job must then stop rather than take its author's roles.
ALTER TABLE "jobs" ADD COLUMN "token_id" uuid;
