import type { Database } from "@anygriddb/db";
import { backupCodeHashes } from "./backup-code.js";
import type { KeyRing } from "./key-ring.js";

export async function replaceBackupCodes(
  db: Database,
  userId: string,
  hashes: string[],
): Promise<void> {
  // The old codes stop working only once the new ones exist.
  await db.transaction().execute(async (tx) => {
    await tx.deleteFrom("backupCodes").where("userId", "=", userId).execute();
    if (hashes.length === 0) return;
    await tx
      .insertInto("backupCodes")
      .values(hashes.map((codeHash) => ({ userId, codeHash })))
      .execute();
  });
}

export async function hasBackupCodes(
  db: Database,
  userId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("backupCodes")
    .select("id")
    .where("userId", "=", userId)
    .executeTakeFirst();
  return Boolean(row);
}

/**
 * Uses a code once. One statement marks it used, so two sign-ins racing
 * with the same code cannot both pass.
 */
export async function consumeBackupCode(
  db: Database,
  userId: string,
  code: string,
  key: KeyRing,
): Promise<boolean> {
  const used = await db
    .updateTable("backupCodes")
    .set({ usedAt: new Date() })
    .where("userId", "=", userId)
    .where("codeHash", "in", backupCodeHashes(code, key))
    .where("usedAt", "is", null)
    .returning("id")
    .executeTakeFirst();
  return Boolean(used);
}
