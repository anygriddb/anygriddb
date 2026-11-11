import { sql } from "kysely";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { AppError } from "@anygriddb/core";

export const eraseAccountInputSchema = z.object({
  password: z.string().min(12).max(128),
});

/** One account every erased person becomes in the audit trail. */
export const ERASED_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Removes the account and the addresses that name it. Row history stays,
 * attributed to the tombstone account, so the record of what changed
 * outlives the person.
 */
export async function eraseAccount(
  db: Database,
  userId: string,
): Promise<void> {
  if (userId === ERASED_USER_ID) throw new AppError("invalid_account");
  const account = await db
    .selectFrom("users")
    .select("email")
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!account) throw new AppError("unknown_account");
  await db.transaction().execute(async (tx) => {
    await sql`select set_config('anygrid.anonymize', 'on', true)`.execute(tx);
    await sql`select set_config('anygrid.user_id', ${ERASED_USER_ID}, true)`.execute(
      tx,
    );
    await sql`select set_config('anygrid.reason', 'Account erasure', true)`.execute(
      tx,
    );
    await tx
      .updateTable("auditEvents")
      .set({ userId: ERASED_USER_ID })
      .where("userId", "=", userId)
      .execute();
    await tx
      .updateTable("rowSignatures")
      .set({ userId: ERASED_USER_ID, displayName: "Erased account" })
      .where("userId", "=", userId)
      .execute();
    await tx
      .updateTable("externalWrites")
      .set({ userId: ERASED_USER_ID })
      .where("userId", "=", userId)
      .execute();
    await tx
      .updateTable("externalStatusEvents")
      .set({ userId: ERASED_USER_ID })
      .where("userId", "=", userId)
      .execute();
    await tx
      .updateTable("authEvents")
      .set({ ip: null })
      .where((eb) =>
        eb.or([eb("userId", "=", userId), eb("actorId", "=", userId)]),
      )
      .execute();
    await tx
      .deleteFrom("invitations")
      .where("email", "=", account.email)
      .execute();
    // A file in a cell is the table's content, as the cell's value is: it
    // stays, without the name of who added it.
    await tx
      .updateTable("attachments")
      .set({ createdBy: null })
      .where("createdBy", "=", userId)
      .execute();
    await tx.deleteFrom("users").where("id", "=", userId).execute();
  });
}
