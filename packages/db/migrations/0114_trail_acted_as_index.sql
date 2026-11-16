-- Deleting an account checks that no event of the change trail still names
-- it as the person an administrator acted as (ADR 0091), and its erasure
-- moves those events to the erased account. Both read the whole trail,
-- the one table that grows without end: 39 ms of a delete's 52 ms at a
-- million events. Few events name such a person, so the index stays small.
CREATE INDEX "audit_events_impersonated_user"
  ON "audit_events" ("impersonated_user_id")
  WHERE "impersonated_user_id" IS NOT NULL;
