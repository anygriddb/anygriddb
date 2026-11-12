import { sql } from "kysely";
import type { Database, Tx } from "@anygriddb/db";
import { z } from "zod";
import { AppError } from "@anygriddb/core";
import { recordAuthEvent } from "../auth/auth-events.js";
import { bindRole, soleOwnerBases } from "./members.js";
import { withTransactionRetry } from "./retry.js";

/**
 * The proof of deleting one's own account: each part is asked when the
 * account has it (`auth/erase-proof.ts`).
 */
export const eraseAccountInputSchema = z.object({
  password: z.string().min(1).max(128).optional(),
  factorCode: z.string().min(1).max(64).optional(),
});

/** One account every erased person becomes in the audit trail. */
export const ERASED_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * An administrator erasing someone else's account (ADR 0051): the email
 * typed to confirm, and the account that takes the bases the erased one
 * alone owns.
 */
export type AdminErasure = {
  actorId: string;
  email: string;
  successorEmail?: string;
};

/**
 * Who takes the erased account's bases: any active account, the
 * administrator's own included. The placeholder account is disabled, so
 * it is refused.
 */
async function successorOf(
  tx: Tx,
  userId: string,
  admin: AdminErasure,
): Promise<string | undefined> {
  if (admin.successorEmail === undefined) return undefined;
  const found = await tx
    .selectFrom("users")
    .select(["id", "disabledAt"])
    .where("email", "=", admin.successorEmail.trim().toLowerCase())
    .executeTakeFirst();
  if (!found) throw new AppError("unknown_account");
  if (found.id === userId || found.disabledAt !== null) {
    throw new AppError("invalid_account");
  }
  return found.id;
}

/**
 * Removes the account and the addresses that name it. Row history and
 * comments stay, attributed to the tombstone account, so the record of
 * what changed outlives the person. Cell values in bases are not
 * rewritten: a base owner must trash or edit those rows if the content
 * itself must go.
 *
 * Every refusal is decided in the transaction that erases, on the locked
 * account, so nothing is written when one applies. The instance keeps an
 * active administrator and a live base keeps an owner: a person hands
 * their bases over before erasing themselves, an administrator names who
 * takes them. An administrator may erase an enabled account: the same
 * transaction disables it first (sessions end), then erases, when no
 * identity provider still manages it. The sign-in trail records it.
 */
export async function eraseAccount(
  db: Database,
  userId: string,
  admin?: AdminErasure,
): Promise<void> {
  if (userId === ERASED_USER_ID) throw new AppError("invalid_account");
  await withTransactionRetry(() =>
    db.transaction().execute(async (tx) => {
      const account = await tx
        .selectFrom("users")
        .select([
          "email",
          "isAdmin",
          "disabledAt",
          "scimUserName",
          "deprovisionedAt",
        ])
        .where("id", "=", userId)
        .forUpdate()
        .executeTakeFirst();
      if (!account) throw new AppError("unknown_account");
      if (admin) {
        const provisioned =
          account.scimUserName !== null && account.deprovisionedAt === null;
        if (
          admin.actorId === userId ||
          account.email.toLowerCase() !== admin.email.trim().toLowerCase() ||
          provisioned
        ) {
          throw new AppError("invalid_account");
        }
      }
      if (account.isAdmin && account.disabledAt === null) {
        // Locking the other active administrators keeps two of them from
        // erasing themselves at the same moment and leaving none.
        const others = await tx
          .selectFrom("users")
          .select("id")
          .where("isAdmin", "=", true)
          .where("disabledAt", "is", null)
          .where("id", "<>", userId)
          .forUpdate()
          .execute();
        if (others.length === 0) throw new AppError("invalid_account");
      }
      // Administrator path: disable first in this transaction when still
      // enabled, so Delete needs no prior step and departure stays on the
      // trail before identity leaves.
      if (admin && account.disabledAt === null) {
        await tx
          .updateTable("users")
          .set({ disabledAt: new Date(), disabledReason: "admin" })
          .where("id", "=", userId)
          .execute();
        await tx.deleteFrom("sessions").where("userId", "=", userId).execute();
        await recordAuthEvent(tx, {
          action: "session_revoked",
          userId,
          actorId: admin.actorId,
          method: "admin",
          detail: "admin_disable",
        });
        account.disabledAt = new Date();
      }
      const owned = await soleOwnerBases(tx, userId);
      if (owned.length > 0) {
        const successorId = admin
          ? await successorOf(tx, userId, admin)
          : undefined;
        if (!admin || successorId === undefined) {
          throw new AppError(
            "invalid_owner",
            owned.map((base) => base.name).join(", "),
          );
        }
        // The hand-over is the administrator's act in the bases' audit.
        await sql`
          select
            set_config('anygrid.user_id', ${admin.actorId}, true),
            set_config('anygrid.source', 'web', true)
        `.execute(tx);
        for (const base of owned) {
          await bindRole(tx, successorId, "owner", base.id);
        }
        await sql`select set_config('anygrid.source', '', true)`.execute(tx);
      }
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
      // Comments are the table's conversation, as cell values are its data:
      // the bodies stay under the tombstone; a manager deletes one if the
      // text itself must leave.
      await tx
        .updateTable("comments")
        .set({ authorId: ERASED_USER_ID })
        .where("authorId", "=", userId)
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
      if (admin) {
        // Written with the erasure or not at all. The account's id leaves
        // the event when the row below goes.
        await recordAuthEvent(tx, {
          action: "account_erased",
          userId,
          actorId: admin.actorId,
          method: "admin",
          detail: "admin_erase",
        });
      }
      await tx.deleteFrom("users").where("id", "=", userId).execute();
    }),
  );
}
