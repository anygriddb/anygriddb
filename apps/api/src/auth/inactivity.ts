/**
 * Disabling accounts nobody used for the instance's delay (ADR 0044), from
 * the hourly purge. Administrators, and accounts an identity provider keeps
 * (SCIM), are never disabled here. With email set up, each person is
 * warned once, a week before (a quarter of the delay when shorter), and
 * disabled only once that week has passed: turning the policy on never
 * disables anyone without notice. Without email, nothing can warn them.
 * A sign-in, a token used, or an administrator enabling the account again
 * starts the count over.
 */
import { inactivityDates, type InstanceSettings } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { resolveSmtp } from "../integrations/smtp.js";
import { smtpReady } from "../mail.js";
import { readSettings } from "../settings.js";
import { recordAuthEvent } from "./auth-events.js";
import { sendSecurityNotice, type SecurityMailDeps } from "./security-mail.js";

const DAY = 86_400_000;

/** The warning's lead: a week, or a quarter of the delay when shorter. */
function lead(days: InstanceSettings["inactiveDays"]): number {
  return Math.min(7, Math.floor(days / 4)) * DAY;
}

/** Accounts this policy may disable: enabled, not admin, not SCIM's. */
function eligible(db: Database) {
  return db
    .selectFrom("users")
    .where("disabledAt", "is", null)
    .where("isAdmin", "=", false)
    .where("scimUserName", "is", null)
    .where("deprovisionedAt", "is", null);
}

export async function sweepInactiveAccounts(
  deps: SecurityMailDeps,
  now: Date = new Date(),
): Promise<{ warned: number; disabled: number }> {
  const { inactiveDays: days } = await readSettings(deps.db);
  if (days === 0) return { warned: 0, disabled: 0 };
  const { config: smtp } = await resolveSmtp(deps.db, deps.env);
  const mail = smtpReady(smtp);
  const idleSince = new Date(now.getTime() - days * DAY);

  // Past the delay, and warned a full lead ago when email can warn.
  let due = eligible(deps.db).select("id").where("activeAt", "<", idleSince);
  if (mail) {
    due = due.where(
      "inactivityWarnedAt",
      "<=",
      new Date(now.getTime() - lead(days)),
    );
  }
  const ids = (await due.execute()).map((row) => row.id);
  const disabled = ids.length
    ? await deps.db.transaction().execute(async (tx) => {
        const rows = await tx
          .updateTable("users")
          .set({ disabledAt: now, disabledReason: "inactive" })
          .where("id", "in", ids)
          .where("disabledAt", "is", null)
          .where("activeAt", "<", idleSince)
          .returning("id")
          .execute();
        const done = rows.map((row) => row.id);
        if (done.length) {
          await tx.deleteFrom("sessions").where("userId", "in", done).execute();
          for (const userId of done) {
            await recordAuthEvent(tx, {
              action: "account_disabled",
              userId,
              detail: "inactive",
            });
          }
        }
        return done;
      })
    : [];
  for (const userId of disabled) {
    await sendSecurityNotice(deps, userId, { kind: "inactive_disabled", days });
  }

  if (!mail) return { warned: 0, disabled: disabled.length };
  const soon = await eligible(deps.db)
    .select("id")
    .where("inactivityWarnedAt", "is", null)
    .where("activeAt", "<", new Date(idleSince.getTime() + lead(days)))
    .execute();
  const warned = soon.length
    ? await deps.db
        .updateTable("users")
        .set({ inactivityWarnedAt: now })
        .where(
          "id",
          "in",
          soon.map((row) => row.id),
        )
        .where("inactivityWarnedAt", "is", null)
        .returning(["id", "activeAt"])
        .execute()
    : [];
  for (const account of warned) {
    // The policy's date, but never sooner than the lead from now.
    const planned = inactivityDates(account.activeAt, { inactiveDays: days });
    const earliest = new Date(now.getTime() + lead(days));
    const disableAt =
      planned && planned.disableAt > earliest ? planned.disableAt : earliest;
    await sendSecurityNotice(deps, account.id, {
      kind: "inactive_soon",
      days,
      disableAt,
    });
  }
  return { warned: warned.length, disabled: disabled.length };
}
