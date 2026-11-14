/**
 * Emergency access (ADR 0074): an administrator reads a base they are not
 * a member of, for an hour, with a reason. It is written to the change
 * trail and the base's owners are told, in the app and by mail: who, why,
 * and until when. The same notice goes out when an administrator gives
 * themselves a role on a base, which is the other way in.
 */
import { AppError, type Binding } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import {
  adminAccessMailBody,
  adminAccessMailSubject,
  type AdminAccessNotice,
} from "../mail-i18n.js";
import { sendMail, smtpReady, type SmtpConfig } from "../mail.js";
import type { Publisher } from "../realtime/bus.js";
import { gridChannel } from "../realtime/channels.js";
import { readMailVoice } from "../settings.js";
import { liveBase } from "./live.js";

/** What the change trail keeps of an opening (`access`): never a value. */
type AccessRecord = { baseId: string; base: string; until: string };

/** The opening an event keeps, or null for any other event. */
export function accessRecordOf(value: unknown): AccessRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<AccessRecord>;
  return typeof record.baseId === "string" &&
    typeof record.base === "string" &&
    typeof record.until === "string"
    ? { baseId: record.baseId, base: record.base, until: record.until }
    : null;
}

/** How long a base stays open, in minutes. */
const EMERGENCY_ACCESS_MINUTES = 60;

export type AccessNoticeDeps = {
  db: Database;
  bus: Publisher;
  smtp: SmtpConfig;
  publicUrl: string;
  log: (error: unknown, message: string) => void;
};

/**
 * The bindings with a viewer's role added on each base an administrator
 * has open: they read it, and change nothing. A role they hold on a base
 * is left as it is.
 */
export function withOpenBases(
  bindings: readonly Binding[],
  baseIds: readonly string[],
): Binding[] {
  const held = new Set(
    bindings
      .filter((binding) => binding.scope === "base")
      .map((binding) => binding.scopeId),
  );
  return [
    ...bindings,
    ...baseIds
      .filter((baseId) => !held.has(baseId))
      .map((baseId) => ({
        role: "viewer" as const,
        scope: "base" as const,
        scopeId: baseId,
      })),
  ];
}

/**
 * The live bases an account has open now. Only an enabled administrator
 * has any: an opening stops counting the moment its author is no longer
 * one, as it does when it expires or is ended.
 */
export async function openBaseIds(
  db: Database,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .selectFrom("emergencyAccess as e")
    .innerJoin("users as u", "u.id", "e.userId")
    .innerJoin("bases", "bases.id", "e.baseId")
    .select("e.baseId")
    .where("e.userId", "=", userId)
    .where("e.endedAt", "is", null)
    .where("e.expiresAt", ">", sql<Date>`now()`)
    .where("u.isAdmin", "=", true)
    .where("u.disabledAt", "is", null)
    .where(liveBase())
    .execute();
  return [...new Set(rows.map((row) => row.baseId))];
}

/**
 * What a person's own session may do: their roles, and reading the bases
 * they have open as an administrator. Not for what runs in their name
 * without them (a token, an automation, a webhook, a feed, a public
 * link): those keep to the roles the account really holds.
 */
export async function sessionBindings(
  db: Database,
  user: { id: string; isAdmin: boolean },
  bindings: readonly Binding[],
): Promise<Binding[]> {
  if (!user.isAdmin) return [...bindings];
  return withOpenBases(bindings, await openBaseIds(db, user.id));
}

/** Who has a base open now, for its owners and for Administration. */
export async function listOpenAccess(db: Database, baseId: string) {
  return db
    .selectFrom("emergencyAccess as e")
    .innerJoin("users as u", "u.id", "e.userId")
    .select([
      "e.userId",
      "u.displayName",
      "e.reason",
      "e.openedAt",
      "e.expiresAt",
    ])
    .where("e.baseId", "=", baseId)
    .where("e.endedAt", "is", null)
    .where("e.expiresAt", ">", sql<Date>`now()`)
    .where("u.isAdmin", "=", true)
    .where("u.disabledAt", "is", null)
    .orderBy("e.openedAt", "asc")
    .execute();
}

/**
 * Opens a live base for an administrator who holds no role on it: read
 * only, for an hour. The opening and its line on the change trail are
 * written together; the owners are told once both are.
 */
export async function openEmergencyAccess(
  deps: AccessNoticeDeps,
  input: {
    admin: { id: string; displayName: string };
    baseId: string;
    reason: string;
  },
): Promise<{ expiresAt: Date }> {
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 500) {
    throw new AppError("reason_required");
  }
  const opened = await deps.db.transaction().execute(async (tx) => {
    const base = await tx
      .selectFrom("bases")
      .select(["id", "name"])
      .where("id", "=", input.baseId)
      .where(liveBase())
      .forUpdate()
      .executeTakeFirst();
    if (!base) throw new AppError("unknown_base");
    const member = await tx
      .selectFrom("roleBindings")
      .select("id")
      .where("userId", "=", input.admin.id)
      .where("scope", "=", "base")
      .where("scopeId", "=", base.id)
      .executeTakeFirst();
    // A member has their role: there is nothing to open.
    if (member) throw new AppError("already_member");
    // One opening at a time: asking again starts the hour again.
    await tx
      .updateTable("emergencyAccess")
      .set({ endedAt: sql<Date>`now()` })
      .where("userId", "=", input.admin.id)
      .where("baseId", "=", base.id)
      .where("endedAt", "is", null)
      .execute();
    const { expiresAt } = await tx
      .insertInto("emergencyAccess")
      .values({
        baseId: base.id,
        userId: input.admin.id,
        reason,
        expiresAt: sql<Date>`now() + make_interval(mins => ${EMERGENCY_ACCESS_MINUTES})`,
      })
      .returning("expiresAt")
      .executeTakeFirstOrThrow();
    await tx
      .insertInto("auditEvents")
      .values({
        userId: input.admin.id,
        action: "access",
        tableId: null,
        recordId: null,
        oldValue: null,
        newValue: {
          baseId: base.id,
          base: base.name,
          until: expiresAt.toISOString(),
        } satisfies AccessRecord,
        reason,
        source: "web",
      })
      .execute();
    return { base, expiresAt };
  });
  await tellOwners(deps, {
    baseId: opened.base.id,
    actorId: input.admin.id,
    notice: {
      mode: "emergency",
      adminName: input.admin.displayName,
      baseName: opened.base.name,
      reason,
      until: opened.expiresAt,
    },
  });
  return { expiresAt: opened.expiresAt };
}

/** Ends an opening before its hour is up. Says whether one was open. */
export async function endEmergencyAccess(
  db: Database,
  input: { userId: string; baseId: string },
): Promise<boolean> {
  const ended = await db
    .updateTable("emergencyAccess")
    .set({ endedAt: sql<Date>`now()` })
    .where("userId", "=", input.userId)
    .where("baseId", "=", input.baseId)
    .where("endedAt", "is", null)
    .where("expiresAt", ">", sql<Date>`now()`)
    .returning("id")
    .execute();
  return ended.length > 0;
}

/**
 * Tells a base's owners that an administrator let themselves in: in the
 * app, and by mail whatever they chose for notifications, since it is
 * about who reads their data. The administrator is not told. A failure
 * to tell is logged, never thrown: what it reports already happened.
 */
export async function tellOwners(
  deps: AccessNoticeDeps,
  input: {
    baseId: string;
    actorId: string;
    notice: AdminAccessNotice;
    /** The owners to tell, when they were read before the change. */
    owners?: readonly string[];
  },
): Promise<number> {
  const owners = await deps.db
    .selectFrom("users as u")
    .select(["u.id", "u.email"])
    .where("u.disabledAt", "is", null)
    .where("u.id", "<>", input.actorId)
    .where((eb) =>
      input.owners
        ? eb("u.id", "in", input.owners.length ? [...input.owners] : [""])
        : eb.exists(
            eb
              .selectFrom("roleBindings as b")
              .select("b.id")
              .whereRef("b.userId", "=", "u.id")
              .where("b.scope", "=", "base")
              .where("b.scopeId", "=", input.baseId)
              .where("b.role", "=", "owner"),
          ),
    )
    .execute();
  if (owners.length === 0) return 0;
  const { notice } = input;
  await deps.db
    .insertInto("notifications")
    .values(
      owners.map((owner) => ({
        userId: owner.id,
        kind: "admin_access" as const,
        actorId: input.actorId,
        data: {
          baseId: input.baseId,
          base: notice.baseName,
          reason: notice.reason,
          ...(notice.mode === "emergency"
            ? { until: notice.until.toISOString() }
            : { role: notice.role }),
        },
      })),
    )
    .execute();
  for (const owner of owners) {
    try {
      await deps.bus.publish(
        gridChannel(owner.id),
        JSON.stringify({ type: "notification", channel: owner.id }),
      );
    } catch (error) {
      deps.log(error, "notification publish failed");
    }
  }
  if (!smtpReady(deps.smtp)) return owners.length;
  const voice = await readMailVoice(deps.db);
  const link = `${deps.publicUrl.replace(/\/+$/, "")}/b/${input.baseId}/settings`;
  for (const owner of owners) {
    await sendMail(deps.smtp, voice, {
      to: owner.email,
      subject: adminAccessMailSubject(voice, notice),
      text: adminAccessMailBody(voice, notice, link),
    }).catch((error: unknown) => deps.log(error, "access notice mail failed"));
  }
  return owners.length;
}
