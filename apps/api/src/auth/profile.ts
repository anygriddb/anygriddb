/**
 * What a person changes of their own account: the name others see. The
 * address stays with an administrator, who corrects it (`admin.ts`): a new
 * one would need its mailbox proved first.
 */
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { recordAuthEvent } from "./auth-events.js";

/**
 * Whether an identity provider keeps the account's name (SCIM, while it
 * provisions it): it would write its own back over a change made here.
 */
export function profileManaged(account: {
  scimUserName: string | null;
  deprovisionedAt: Date | string | null;
}): boolean {
  return account.scimUserName !== null && account.deprovisionedAt === null;
}

/**
 * Renames the signed-in person. The sign-in trail says the name changed,
 * by the person, never what it was or became. Answers whether it changed.
 */
export async function renameOwnAccount(
  db: Database,
  input: { userId: string; displayName: string; ip: string | null },
): Promise<boolean> {
  return db.transaction().execute(async (tx) => {
    const account = await tx
      .selectFrom("users")
      .select(["displayName", "scimUserName", "deprovisionedAt"])
      .where("id", "=", input.userId)
      .forUpdate()
      .executeTakeFirst();
    if (!account) throw new AppError("unknown_account");
    if (profileManaged(account)) throw new AppError("invalid_account");
    if (account.displayName === input.displayName) return false;
    await tx
      .updateTable("users")
      .set({ displayName: input.displayName })
      .where("id", "=", input.userId)
      .execute();
    await recordAuthEvent(tx, {
      action: "account_updated",
      userId: input.userId,
      actorId: input.userId,
      detail: "display_name",
      ip: input.ip,
    });
    return true;
  });
}
