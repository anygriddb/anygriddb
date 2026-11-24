/**
 * An administrator acts with another person's rights for thirty minutes
 * (ADR 0091). The session stays theirs. The change trail names both.
 */
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { KeyRing } from "../auth/key-ring.js";
import { recordAuthEvent } from "../auth/auth-events.js";
import { actingAsMailBody, actingAsMailSubject } from "../mail-i18n.js";
import { smtpReady, type SmtpConfig } from "../mail.js";
import { deliverPersonNotices } from "../notify/deliver-person.js";
import { actingAsCounted } from "../observability.js";
import type { Publisher } from "../realtime/bus.js";
import { readMailVoice } from "../settings.js";
import { holdsInstanceRole } from "../auth/instance-roles.js";
import { ERASED_USER_ID } from "./erasure.js";

const ACTING_MS = 30 * 60 * 1000;
const REASON_MAX = 200;

export function cleanActingReason(raw: string): string {
  const reason = raw
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (reason.length < 1 || reason.length > REASON_MAX) {
    throw new AppError("cannot_act_as");
  }
  return reason;
}

type Target = {
  id: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  isSupport: boolean;
  isAuditor: boolean;
  /** Holds a part of Administration given apart (ADR 0126). */
  hasInstanceRole: boolean;
  disabledAt: Date | null;
};

/** Why this person cannot be acted as. Null when they can. */
export function actingRefusal(
  actorId: string,
  target: Target | undefined,
): "missing" | "self" | "privileged" | "disabled" | "tombstone" | null {
  if (!target) return "missing";
  if (target.id === ERASED_USER_ID) return "tombstone";
  if (target.id === actorId) return "self";
  if (
    target.isAdmin ||
    target.isSupport ||
    target.isAuditor ||
    target.hasInstanceRole
  )
    return "privileged";
  if (target.disabledAt) return "disabled";
  return null;
}

type NoticeDeps = {
  bus: Publisher;
  smtp: SmtpConfig | null;
  publicUrl: string;
  log: (error: unknown, message: string) => void;
  keys?: KeyRing;
};

export async function startActing(
  db: Database,
  input: {
    actorId: string;
    actorName: string;
    sessionId: string;
    targetId: string;
    reason: string;
    ip?: string;
  },
  deps: NoticeDeps,
): Promise<{ until: string }> {
  const reason = cleanActingReason(input.reason);
  const session = await db
    .selectFrom("sessions")
    .select(["id", "userId", "impersonatedUserId", "impersonateUntil"])
    .where("id", "=", input.sessionId)
    .where("userId", "=", input.actorId)
    .executeTakeFirst();
  if (!session) {
    actingAsCounted("refused");
    throw new AppError("cannot_act_as");
  }
  if (
    session.impersonatedUserId &&
    session.impersonateUntil &&
    session.impersonateUntil.getTime() > Date.now()
  ) {
    actingAsCounted("refused");
    throw new AppError("already_acting");
  }
  const target = await db
    .selectFrom("users")
    .select([
      "id",
      "displayName",
      "email",
      "isAdmin",
      "isSupport",
      "isAuditor",
      holdsInstanceRole("users.id").as("hasInstanceRole"),
      "disabledAt",
    ])
    .where("id", "=", input.targetId)
    .executeTakeFirst();
  if (actingRefusal(input.actorId, target)) {
    actingAsCounted("refused");
    throw new AppError("cannot_act_as");
  }
  const person = target as Target;
  const until = new Date(Date.now() + ACTING_MS);
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("sessions")
      .set({ impersonatedUserId: person.id, impersonateUntil: until })
      .where("id", "=", session.id)
      .execute();
    await recordAuthEvent(tx, {
      action: "acting_as_started",
      userId: person.id,
      actorId: input.actorId,
      method: "admin",
      detail: reason,
      ip: input.ip,
    });
  });
  actingAsCounted("started");
  await tellPerson(db, deps, {
    person,
    actorId: input.actorId,
    actorName: input.actorName,
    reason,
    until,
  });
  return { until: until.toISOString() };
}

export async function stopActing(
  db: Database,
  input: { actorId: string; sessionId: string; ip?: string },
): Promise<{ stopped: boolean }> {
  const session = await db
    .selectFrom("sessions")
    .select(["id", "impersonatedUserId"])
    .where("id", "=", input.sessionId)
    .where("userId", "=", input.actorId)
    .executeTakeFirst();
  if (!session?.impersonatedUserId) return { stopped: false };
  const personId = session.impersonatedUserId;
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("sessions")
      .set({ impersonatedUserId: null, impersonateUntil: null })
      .where("id", "=", session.id)
      .execute();
    await recordAuthEvent(tx, {
      action: "acting_as_ended",
      userId: personId,
      actorId: input.actorId,
      method: "admin",
      detail: "stopped",
      ip: input.ip,
    });
  });
  actingAsCounted("ended");
  return { stopped: true };
}

async function tellPerson(
  db: Database,
  deps: NoticeDeps,
  input: {
    person: Target;
    actorId: string;
    actorName: string;
    reason: string;
    until: Date;
  },
): Promise<void> {
  const voice = await readMailVoice(db);
  // Empty config fails smtpReady: the bell and digests still run.
  const smtp = deps.smtp && smtpReady(deps.smtp) ? deps.smtp : {};
  await deliverPersonNotices(
    {
      db,
      bus: deps.bus,
      smtp,
      webOrigin: deps.publicUrl,
      log: deps.log,
      keys: deps.keys,
    },
    [
      {
        userId: input.person.id,
        event: "acting_as",
        bellKind: "acting_as",
        actorId: input.actorId,
        data: {
          reason: input.reason,
          until: input.until.toISOString(),
        },
        mail: {
          subject: actingAsMailSubject(voice),
          text: actingAsMailBody(voice, {
            adminName: input.actorName,
            reason: input.reason,
            until: input.until,
          }),
        },
      },
    ],
  );
}
