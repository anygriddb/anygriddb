/**
 * Locking an account after failed passwords and codes (ADR 0043). The
 * count is per account, so many addresses guessing one account meet the
 * same limit the per-address rate limit cannot see. A lock lasts as the
 * instance says, from `locked_at`: the policy applies to locks already
 * there. Single sign-on is the identity provider's business, and is not
 * locked; its second step here is.
 */
import { AppError, type InstanceSettings, lockState } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { recordAuthEvent } from "./auth-events.js";

export type LockedAccount = {
  id: string;
  isAdmin: boolean;
  lockedAt: Date | null;
};

/**
 * Whether the account is locked now, and until when (null: until an
 * administrator unlocks it). A lock that has run out is cleared, and the
 * count starts over.
 */
export async function currentLock(
  db: Database,
  account: LockedAccount,
  policy: Pick<InstanceSettings, "lockoutMinutes">,
): Promise<{ locked: false } | { locked: true; until: Date | null }> {
  const state = lockState(account.lockedAt, policy, account.isAdmin);
  if (!state.locked && account.lockedAt) {
    await db
      .updateTable("users")
      .set({ failedSignIns: 0, lockedAt: null })
      .where("id", "=", account.id)
      .where("lockedAt", "=", account.lockedAt)
      .execute();
  }
  return state;
}

/** Reads an account's lock by id; an unknown account is not locked. */
export async function lockOf(
  db: Database,
  userId: string,
  policy: Pick<InstanceSettings, "lockoutMinutes">,
): Promise<{ locked: false } | { locked: true; until: Date | null }> {
  const account = await db
    .selectFrom("users")
    .select(["id", "isAdmin", "lockedAt"])
    .where("id", "=", userId)
    .executeTakeFirst();
  return account ? currentLock(db, account, policy) : { locked: false };
}

/**
 * One more failure. Returns true when this one locked the account, which
 * the trail then keeps.
 */
export async function countFailure(
  db: Database,
  userId: string,
  policy: Pick<InstanceSettings, "lockoutThreshold">,
  ip?: string,
): Promise<boolean> {
  const locked = await db.transaction().execute(async (tx) => {
    const row = await tx
      .selectFrom("users")
      .select(["failedSignIns", "lockedAt"])
      .where("id", "=", userId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return false;
    const failed = row.failedSignIns + 1;
    const lock = row.lockedAt === null && failed >= policy.lockoutThreshold;
    await tx
      .updateTable("users")
      .set(
        lock
          ? { failedSignIns: failed, lockedAt: new Date() }
          : { failedSignIns: failed },
      )
      .where("id", "=", userId)
      .execute();
    return lock;
  });
  if (locked) {
    await recordAuthEvent(db, { action: "account_locked", userId, ip });
  }
  return locked;
}

/** A success, or a new password: the count starts over. */
export async function clearFailures(
  db: Database,
  userId: string,
): Promise<void> {
  await db
    .updateTable("users")
    .set({ failedSignIns: 0, lockedAt: null })
    .where("id", "=", userId)
    .where((eb) =>
      eb.or([eb("failedSignIns", ">", 0), eb("lockedAt", "is not", null)]),
    )
    .execute();
}

/** An administrator lifts a lock; the trail names them. */
export async function unlockAccount(
  db: Database,
  actorId: string,
  userId: string,
): Promise<void> {
  const updated = await db
    .updateTable("users")
    .set({ failedSignIns: 0, lockedAt: null })
    .where("id", "=", userId)
    .returning("id")
    .executeTakeFirst();
  if (!updated) throw new AppError("unknown_account");
  await recordAuthEvent(db, {
    action: "account_unlocked",
    userId,
    actorId,
    method: "admin",
    detail: "admin_unlock",
  });
}
