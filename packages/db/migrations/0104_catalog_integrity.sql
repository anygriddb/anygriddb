-- Account erasure rewrites the author of these trails, and a delete of
-- the account must find every row. The same columns were indexed for
-- audit_events and comments; these four were still read from one end to
-- the other. webhooks.table_id is read on every row write.
CREATE INDEX "external_writes_user" ON "external_writes" ("user_id");
CREATE INDEX "external_status_events_user" ON "external_status_events" ("user_id");
CREATE INDEX "row_signatures_user" ON "row_signatures" ("user_id");
CREATE INDEX "attachments_created_by" ON "attachments" ("created_by");
CREATE INDEX "webhooks_table_idx" ON "webhooks" ("table_id");

-- One role for a person on one object, and one role a group gives them.
-- Two grants at once could insert both. A read takes the highest of
-- them, so that one stays and the others go: nobody's access changes,
-- and the migration's flag keeps the trail out of a cleanup that changes
-- no right. scope_id names a base, a table, a row, or a column, so it is
-- not a foreign key.
SELECT set_config('anygrid.migrate', 'on', true);
DELETE FROM "role_bindings"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (
      PARTITION BY "user_id", "scope", "scope_id", "group_id"
      ORDER BY CASE "role"
        WHEN 'owner' THEN 4
        WHEN 'editor' THEN 3
        WHEN 'commenter' THEN 2
        ELSE 1
      END DESC, "id"
    ) AS "place"
    FROM "role_bindings"
  ) AS "ranked"
  WHERE "place" > 1
);
CREATE UNIQUE INDEX "role_bindings_direct"
  ON "role_bindings" ("user_id", "scope", "scope_id")
  WHERE "group_id" IS NULL;
CREATE UNIQUE INDEX "role_bindings_from_group"
  ON "role_bindings" ("group_id", "user_id", "scope", "scope_id")
  WHERE "group_id" IS NOT NULL;

-- Addresses are stored in lower case. The old unique constraint compared
-- them as written, so Ada@ and ada@ could both exist.
UPDATE "users" SET "email" = lower("email") WHERE "email" <> lower("email");
ALTER TABLE "users" DROP CONSTRAINT "users_email_unique";
-- The expression index stops Ada@ and ada@. A lookup is `email = $1`
-- with the address already in lower case, which that expression does
-- not serve, so the column keeps an index of its own.
CREATE UNIQUE INDEX "users_email_lower" ON "users" (lower("email"));
CREATE INDEX "users_email" ON "users" ("email");

-- A file in a cell stays when the account that added it goes. Erasure
-- already cleared the author; the constraint now says the same thing.
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_created_by_users_id_fk";
ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL;

-- The other deleted_by columns are ON DELETE SET NULL. This one had no
-- action, so a delete that skipped the erasure update failed.
ALTER TABLE "table_folders" DROP CONSTRAINT "table_folders_deleted_by_fkey";
ALTER TABLE "table_folders"
  ADD CONSTRAINT "table_folders_deleted_by_fkey"
  FOREIGN KEY ("deleted_by") REFERENCES "users" ("id") ON DELETE SET NULL;

-- The only catalog id still drawn at random. New rows follow the others.
ALTER TABLE "signup_requests" ALTER COLUMN "id" SET DEFAULT ag_uuidv7();
