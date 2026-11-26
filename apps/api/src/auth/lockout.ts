/**
 * Locking an account after failed passwords and codes (ADR 0043). The
 * count is per account, so many addresses guessing one account meet the
 * same limit the per-address rate limit cannot see. A lock lasts as the
 * instance says, from `locked_at`: the policy applies to locks already
 * there. Single sign-on is the identity provider's business, and is not
 * locked; its second step here is.
 */
import { isAdminOf } from "./instance-roles.js";
import { createHash } from "node:crypto";
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
    .select(["id", isAdminOf("users.id").as("isAdmin"), "lockedAt"])
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
    const { emitInstanceEvent } = await import("../notify/dispatch.js");
    await emitInstanceEvent(db, () => undefined, {
      type: "auth.login_failed_burst",
      subject: userId,
      fields: {},
    });
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

/**
 * The lock of an address that has no account to lock. A known account
 * answers `account_locked` once its failures reach the instance's count,
 * and an address that never did told, by that alone, that it has none. So
 * its failures are counted too, by the same policy: here, in memory, since
 * there is no row to keep them on. Nothing is kept of the address but a
 * digest, and the oldest are forgotten past `UNKNOWN_ADDRESSES`.
 */
const unknownAddresses = new Map<
  string,
  { failed: number; lockedAt: Date | null }
>();
const UNKNOWN_ADDRESSES = 20_000;

function addressKey(address: string): string {
  return createHash("sha256")
    .update(address.trim().toLowerCase())
    .digest("hex");
}

/**
 * Whether an address with no account is locked now, as an account would
 * be. A lock that has run out is forgotten, and the count starts over.
 */
export function unknownAddressLocked(
  address: string,
  policy: Pick<InstanceSettings, "lockoutMinutes">,
  now: Date = new Date(),
): boolean {
  const key = addressKey(address);
  const kept = unknownAddresses.get(key);
  if (!kept?.lockedAt) return false;
  if (lockState(kept.lockedAt, policy, false, now).locked) return true;
  unknownAddresses.delete(key);
  return false;
}

/** One more failure on an address with no account. */
export function countUnknownAddressFailure(
  address: string,
  policy: Pick<InstanceSettings, "lockoutThreshold">,
  now: Date = new Date(),
): void {
  const key = addressKey(address);
  const failed = (unknownAddresses.get(key)?.failed ?? 0) + 1;
  // Written again at the end: the oldest entry is the one least lately used.
  unknownAddresses.delete(key);
  unknownAddresses.set(key, {
    failed,
    lockedAt: failed >= policy.lockoutThreshold ? now : null,
  });
  while (unknownAddresses.size > UNKNOWN_ADDRESSES) {
    const oldest = unknownAddresses.keys().next();
    if (oldest.done) break;
    unknownAddresses.delete(oldest.value);
  }
}

/** Forgets every address counted: for tests, which share the process. */
export function forgetUnknownAddresses(): void {
  unknownAddresses.clear();
}
