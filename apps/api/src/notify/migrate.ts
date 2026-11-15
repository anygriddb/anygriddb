import type { Database } from "@anygriddb/db";
import { loggedError } from "../logged-error.js";
import { emitInstanceEvent } from "./dispatch.js";

/**
 * A migration that fails after these tables exist can still tell the
 * channels. If the database itself is down, or the tables are not there
 * yet, there is nothing to tell and the process exits either way.
 */
export async function notifyMigrationFailure(
  db: Database,
  error: unknown,
): Promise<void> {
  console.error("database migration failed", loggedError(error));
  await emitInstanceEvent(db, () => undefined, {
    type: "migration.failed",
    subject: "startup",
    fields: { code: "migration_failed" },
  });
}
