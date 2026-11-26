/**
 * An operator's way back in (ADR 0082). When no administrator can sign in
 * (a password forgotten where no mail goes out, a second factor lost, an
 * identity provider out of reach, a list of sign-in addresses that leaves
 * everyone out), whoever runs the instance runs `anygriddb admin recover`
 * where it runs. One account becomes an active administrator and gets a
 * link that sets its password, once, within the hour. What the command
 * changed is on the sign-in trail as done from the command line, under no
 * account's name: nobody was signed in.
 */
import { giveOwnInstanceRole, isAdminOf } from "./instance-roles.js";
import { labelSchema } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { hasAccounts } from "../admin.js";
import { ERASED_USER_ID } from "../data/erasure.js";
import { readSettings } from "../settings.js";
import { recordAuthEvent } from "./auth-events.js";
import {
  createResetLink,
  passwordState,
  SELF_RESET_TTL_MS,
} from "./password-reset.js";

export const recoveryInputSchema = z
  .object({
    email: z.email().max(254),
    /**
     * The name of the account to make when the address has none. Typed
     * on a command line, where a word that starts with a dash is the
     * next option, not a name.
     */
    create: labelSchema.refine((name) => !name.startsWith("-")).optional(),
    clearFactors: z.boolean().default(false),
    anyAddress: z.boolean().default(false),
  })
  .strict();

type RecoveryInput = z.input<typeof recoveryInputSchema>;

/**
 * Why nothing was done: the instance has no account at all (its first is
 * made with the install token), the address has no account and none was
 * asked for, its account keeps no password (its identity provider signs
 * it in, ADR 0053), or it is the address erased accounts take.
 */
export type RecoveryRefusal =
  "no_accounts" | "unknown_address" | "provider_account" | "reserved_address";

export class RecoveryRefused extends Error {
  constructor(readonly reason: RecoveryRefusal) {
    super(reason);
  }
}

/** What the command changed, in the order it did. */
export type RecoveryChange =
  "created" | "admin" | "enabled" | "factors" | "addresses";

export type Recovery = {
  userId: string;
  changed: RecoveryChange[];
  /** The ranges sign-in is still limited to, once the command is done. */
  addressRanges: number;
  link: { token: string; expiresAt: Date };
};

/**
 * Makes the account of an address an active administrator, and a link
 * that sets its password. An account already there keeps its second
 * factors unless asked otherwise, so the link alone does not open it.
 * Asked twice, it changes nothing the second time and makes a new link in
 * place of the first.
 */
export async function recoverAdministrator(
  db: Database,
  given: RecoveryInput,
): Promise<Recovery> {
  const input = recoveryInputSchema.parse(given);
  const email = input.email.toLowerCase();
  if (!(await hasAccounts(db))) throw new RecoveryRefused("no_accounts");
  const done = await db.transaction().execute(async (tx) => {
    const changed: RecoveryChange[] = [];
    const found = await tx
      .selectFrom("users")
      .select(["id", isAdminOf("users.id").as("isAdmin"), "disabledAt"])
      .where("email", "=", email)
      .forUpdate()
      .executeTakeFirst();
    // The account every erased person becomes is nobody's to open.
    if (found?.id === ERASED_USER_ID) {
      throw new RecoveryRefused("reserved_address");
    }
    let userId: string;
    if (found) {
      userId = found.id;
      if ((await passwordState(tx, userId)) === "provider") {
        throw new RecoveryRefused("provider_account");
      }
      if (!found.isAdmin) {
        await giveOwnInstanceRole(tx, {
          userId,
          role: "administrator",
          source: "command",
        });
        changed.push("admin");
        await recordAuthEvent(tx, {
          action: "account_updated",
          userId,
          method: "command",
          detail: "admin_granted",
        });
      }
      if (found.disabledAt) {
        await tx
          .updateTable("users")
          .set({
            disabledAt: null,
            disabledReason: null,
            // The time without activity starts over.
            activeAt: new Date(),
            inactivityWarnedAt: null,
          })
          .where("id", "=", userId)
          .execute();
        changed.push("enabled");
        await recordAuthEvent(tx, {
          action: "account_updated",
          userId,
          method: "command",
          detail: "enabled",
        });
      }
      if (input.clearFactors && (await removeFactors(tx, userId))) {
        changed.push("factors");
        await recordAuthEvent(tx, {
          action: "factors_cleared",
          userId,
          method: "command",
        });
      }
    } else {
      if (input.create === undefined) {
        throw new RecoveryRefused("unknown_address");
      }
      const made = await tx
        .insertInto("users")
        .values({ email, displayName: input.create })
        .returning("id")
        .executeTakeFirstOrThrow();
      userId = made.id;
      await giveOwnInstanceRole(tx, {
        userId,
        role: "administrator",
        source: "command",
      });
      changed.push("created");
      await recordAuthEvent(tx, {
        action: "account_created",
        userId,
        method: "command",
        detail: "as_admin",
      });
    }
    let addressRanges = (await readSettings(tx)).signInAllowlist.length;
    if (input.anyAddress && addressRanges > 0) {
      // No row: the setting takes its default, any address.
      await tx
        .deleteFrom("instanceSettings")
        .where("key", "=", "signInAllowlist")
        .execute();
      addressRanges = 0;
      changed.push("addresses");
      await recordAuthEvent(tx, {
        action: "settings_changed",
        method: "command",
        detail: "signInAllowlist",
      });
    }
    return { userId, changed, addressRanges };
  });
  const link = await createResetLink(db, {
    userId: done.userId,
    createdBy: null,
    ttlMs: SELF_RESET_TTL_MS,
  });
  await recordAuthEvent(db, {
    action: "password_reset_requested",
    userId: done.userId,
    method: "command",
  });
  return { ...done, link };
}

/** Removes an account's second factors and sessions; false when it had none. */
async function removeFactors(db: Database, userId: string): Promise<boolean> {
  let removed = 0n;
  for (const table of [
    "totpSecrets",
    "webauthnCredentials",
    "emailFactors",
    "emailOtpCodes",
    "backupCodes",
  ] as const) {
    const result = await db
      .deleteFrom(table)
      .where("userId", "=", userId)
      .executeTakeFirst();
    removed += result.numDeletedRows;
  }
  if (removed === 0n) return false;
  await db.deleteFrom("sessions").where("userId", "=", userId).execute();
  return true;
}
