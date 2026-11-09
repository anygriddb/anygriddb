import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { AppError } from "@anygriddb/core";

export const eraseAccountInputSchema = z.object({
  password: z.string().min(12).max(128),
});

export async function eraseAccount(
  db: Database,
  userId: string,
): Promise<void> {
  const [audited, written, statused, signed, bound, ruled] = await Promise.all([
    db
      .selectFrom("auditEvents")
      .select("id")
      .where("userId", "=", userId)
      .executeTakeFirst(),
    // Writes to client tables and the statuses of their rows: their trails.
    db
      .selectFrom("externalWrites")
      .select("id")
      .where("userId", "=", userId)
      .executeTakeFirst(),
    db
      .selectFrom("externalStatusEvents")
      .select("id")
      .where("userId", "=", userId)
      .executeTakeFirst(),
    db
      .selectFrom("rowSignatures")
      .select("id")
      .where("userId", "=", userId)
      .executeTakeFirst(),
    db
      .selectFrom("roleBindings")
      .select("id")
      .where("userId", "=", userId)
      .executeTakeFirst(),
    // Access rules are audited: removing them needs a manager's action.
    db
      .selectFrom("tableAcls")
      .select("id")
      .where("userId", "=", userId)
      .executeTakeFirst(),
  ]);
  if (audited || written || statused || signed || bound || ruled) {
    throw new AppError("audit_history_retained");
  }
  await db.transaction().execute(async (tx) => {
    // The sign-in trail keeps the events, not who or where: the account's
    // id is cleared by the foreign key, its addresses here.
    await tx
      .updateTable("authEvents")
      .set({ ip: null })
      .where("userId", "=", userId)
      .execute();
    await tx.deleteFrom("users").where("id", "=", userId).execute();
  });
}
