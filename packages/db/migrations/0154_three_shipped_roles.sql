-- Three more shipped roles of a base (ADR 0131, §7), beside the four of a
-- rank: a reader reads and comments and takes nothing out, a contributor
-- edits without exporting or publishing, a validator takes a circuit's
-- steps. A circuit's step may name them as it names the four.
ALTER TYPE "role" ADD VALUE IF NOT EXISTS 'contributor';
ALTER TYPE "role" ADD VALUE IF NOT EXISTS 'validator';
ALTER TYPE "role" ADD VALUE IF NOT EXISTS 'reader';

ALTER TABLE "status_transition_grants"
  DROP CONSTRAINT "status_transition_grants_role_key",
  ADD CONSTRAINT "status_transition_grants_role_key"
    CHECK ("role_key" IN ('owner', 'editor', 'commenter', 'viewer',
      'contributor', 'validator', 'reader'));
