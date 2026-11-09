import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { AppError } from "@anygriddb/core";

/**
 * Takes a lock for `ttlSeconds`, or renews it for its owner. Another owner
 * gets it only once it expired. One statement, so two processes racing
 * for a free lock cannot both win.
 */
export async function acquireLock(
  db: Database,
  input: { key: string; owner: string; ttlSeconds: number },
): Promise<boolean> {
  if (
    !Number.isInteger(input.ttlSeconds) ||
    input.ttlSeconds < 1 ||
    input.ttlSeconds > 120
  ) {
    throw new AppError("invalid_lock_ttl");
  }
  const taken = await db
    .insertInto("ephemeralLocks")
    .values({
      key: input.key,
      owner: input.owner,
      expiresAt: sql<Date>`now() + make_interval(secs => ${input.ttlSeconds})`,
    })
    .onConflict((conflict) =>
      conflict
        .column("key")
        .doUpdateSet({
          owner: input.owner,
          expiresAt: sql<Date>`now() + make_interval(secs => ${input.ttlSeconds})`,
        })
        .where((eb) =>
          eb.or([
            eb("ephemeralLocks.expiresAt", "<", sql<Date>`now()`),
            eb("ephemeralLocks.owner", "=", input.owner),
          ]),
        ),
    )
    .returning("key")
    .executeTakeFirst();
  return Boolean(taken);
}

export async function purgeLocks(db: Database): Promise<void> {
  await db
    .deleteFrom("ephemeralLocks")
    .where("expiresAt", "<", sql<Date>`now()`)
    .execute();
}
