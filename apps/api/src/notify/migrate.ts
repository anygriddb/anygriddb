import { UpgradeRefused, type Database } from "@anygriddb/db";
import { loggedError } from "../logged-error.js";
import { emitInstanceEvent } from "./dispatch.js";

/**
 * What the start prints of a migration that did not run. An upgrade
 * refused before it changed anything is no fault to look into: its
 * message is what the migration's check wrote for the operator, said as
 * it is, alone (ADR 0106). Any other failure is logged as an error is.
 */
export function migrationFailureLine(error: unknown): unknown[] {
  return error instanceof UpgradeRefused
    ? [error.message]
    : ["database migration failed", loggedError(error)];
}

/**
 * A migration that fails after these tables exist can still tell the
 * channels. If the database itself is down, or the tables are not there
 * yet, there is nothing to tell and the process exits either way.
 */
export async function notifyMigrationFailure(
  db: Database,
  error: unknown,
): Promise<void> {
  console.error(...migrationFailureLine(error));
  await emitInstanceEvent(db, () => undefined, {
    type: "migration.failed",
    subject: "startup",
    fields: { code: "migration_failed" },
  });
}
