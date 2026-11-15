import { createHash, randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { AppError, sessionWindows } from "@anygriddb/core";
import { recordAuthEvent } from "./auth-events.js";
import { ERASED_USER_ID } from "../data/erasure.js";
import { readGateSettings, readSettings } from "../settings.js";

export const SESSION_COOKIE = "__Host-ag_session";

/**
 * A session ends after an idle window, renewed while it is used, and at an
 * absolute lifetime in any case. Both are the instance's (ADR 0043): 15
 * minutes and 12 hours by default.
 */
type SessionWindows = { idleMs: number; maxMs: number };

/**
 * Session cookies are HttpOnly, SameSite=Strict, and always Secure: the
 * browser sends them over HTTPS only (ADR 0029). The `__Host-` prefix
 * makes the browser refuse one set without Secure, for another path, or
 * for a parent domain.
 */
export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true as const,
    secure: true as const,
    sameSite: "strict" as const,
    path: "/",
    expires: expiresAt,
  };
}

const SESSION_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  isSupport: boolean;
  /** Reads Administration and changes nothing (ADR 0071). */
  isAuditor: boolean;
  /** This cookie's session, when the lookup has one. */
  sessionId?: string;
  /**
   * Set while this administrator uses another person's rights (ADR 0091).
   * The id above stays the administrator.
   */
  actingAs?: {
    id: string;
    displayName: string;
    until: string;
  } | null;
};

export function isSessionToken(token: string | undefined): token is string {
  return typeof token === "string" && SESSION_TOKEN.test(token);
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function findSessionUser(
  db: Database,
  token: string | undefined,
): Promise<SessionUser | null> {
  if (!isSessionToken(token)) {
    return null;
  }
  const row = await db
    .selectFrom("sessions as s")
    .innerJoin("users as u", "u.id", "s.userId")
    .leftJoin("users as p", "p.id", "s.impersonatedUserId")
    .select([
      "s.id as sessionId",
      "s.impersonatedUserId",
      "s.impersonateUntil",
      "u.id",
      "u.email",
      "u.displayName",
      "u.isAdmin",
      "u.isSupport",
      "u.isAuditor",
      "p.displayName as personName",
      "p.disabledAt as personDisabled",
      "p.isAdmin as personAdmin",
      "p.isSupport as personSupport",
      "p.isAuditor as personAuditor",
    ])
    .where("s.tokenHash", "=", hashSessionToken(token))
    .where("s.expiresAt", ">", new Date())
    .where("u.disabledAt", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  const until = row.impersonateUntil;
  const personId = row.impersonatedUserId;
  const allowed =
    personId !== null &&
    until !== null &&
    until.getTime() > Date.now() &&
    row.personDisabled === null &&
    row.personAdmin !== true &&
    row.personSupport !== true &&
    row.personAuditor !== true &&
    personId !== ERASED_USER_ID;
  if (personId !== null && !allowed) {
    await db
      .updateTable("sessions")
      .set({ impersonatedUserId: null, impersonateUntil: null })
      .where("id", "=", row.sessionId)
      .execute();
    await recordAuthEvent(db, {
      action: "acting_as_ended",
      userId: personId,
      actorId: row.id,
      method: "admin",
      detail: "expired",
    });
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    isAdmin: row.isAdmin,
    isSupport: row.isSupport,
    isAuditor: row.isAuditor,
    sessionId: row.sessionId,
    actingAs:
      personId !== null && until !== null && allowed
        ? {
            id: personId,
            displayName: row.personName ?? "",
            until: until.toISOString(),
          }
        : null,
  };
}

/** True while this session hash still belongs to a live, enabled account. */
export async function sessionHashAlive(
  db: Database,
  tokenHash: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("sessions as s")
    .innerJoin("users as u", "u.id", "s.userId")
    .select("s.tokenHash")
    .where("s.tokenHash", "=", tokenHash)
    .where("s.expiresAt", ">", new Date())
    .where("u.disabledAt", "is", null)
    .executeTakeFirst();
  return row !== undefined;
}

/** Of these session hashes, those of a live, enabled account: one query. */
export async function sessionHashesAlive(
  db: Database,
  tokenHashes: readonly string[],
): Promise<Set<string>> {
  if (tokenHashes.length === 0) return new Set();
  const rows = await db
    .selectFrom("sessions as s")
    .innerJoin("users as u", "u.id", "s.userId")
    .select("s.tokenHash")
    .where("s.tokenHash", "in", tokenHashes)
    .where("s.expiresAt", ">", new Date())
    .where("u.disabledAt", "is", null)
    .execute();
  return new Set(rows.map((row) => row.tokenHash));
}

/**
 * Idle-timeout renewal. Returns the new expiry when less than half of the
 * idle window is left and the absolute lifetime still allows it, else null.
 */
export function planSessionRenewal(
  createdAt: Date,
  expiresAt: Date,
  now: Date,
  windows: SessionWindows,
): Date | null {
  const remaining = expiresAt.getTime() - now.getTime();
  if (remaining <= 0 || remaining > windows.idleMs / 2) {
    return null;
  }
  const ceiling = createdAt.getTime() + windows.maxMs;
  const next = Math.min(now.getTime() + windows.idleMs, ceiling);
  if (next <= expiresAt.getTime()) {
    return null;
  }
  return new Date(next);
}

/** Extends a live session when `planSessionRenewal` allows it. */
export async function renewSession(
  db: Database,
  token: string | undefined,
  now: Date = new Date(),
): Promise<Date | null> {
  if (!isSessionToken(token)) {
    return null;
  }
  const tokenHash = hashSessionToken(token);
  const session = await db
    .selectFrom("sessions")
    .select(["createdAt", "expiresAt"])
    .where("tokenHash", "=", tokenHash)
    .where("expiresAt", ">", now)
    .executeTakeFirst();
  if (!session) {
    return null;
  }
  const next = planSessionRenewal(
    session.createdAt,
    session.expiresAt,
    now,
    sessionWindows(await readGateSettings(db)),
  );
  if (!next) {
    return null;
  }
  await db
    .updateTable("sessions")
    .set({ expiresAt: next })
    .where("tokenHash", "=", tokenHash)
    .execute();
  return next;
}

/**
 * Drops the presented session so login always continues with a new id.
 * Returns whose session it was, when one was live.
 */
export async function revokeSession(
  db: Database,
  token: string | undefined,
): Promise<{ userId: string } | null> {
  if (!isSessionToken(token)) {
    return null;
  }
  const removed = await db
    .deleteFrom("sessions")
    .where("tokenHash", "=", hashSessionToken(token))
    .returning("userId")
    .executeTakeFirst();
  return removed ?? null;
}

export async function createSession(
  db: Database,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  // Every sign-in path ends here, so a disabled account, or anyone but an
  // administrator during maintenance, is stopped here.
  const account = await db
    .selectFrom("users")
    .select(["disabledAt", "isAdmin"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!account || account.disabledAt) {
    throw new AppError("account_disabled");
  }
  const settings = await readSettings(db);
  if (!account.isAdmin && settings.maintenance) {
    throw new AppError("instance_maintenance");
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionWindows(settings).idleMs);
  await db
    .insertInto("sessions")
    .values({ userId, tokenHash: hashSessionToken(token), expiresAt })
    .execute();
  // Active again: an inactive account's count starts over (ADR 0044).
  // The sign-in's date stays on the account: its session will not.
  const now = new Date();
  await db
    .updateTable("users")
    .set({ activeAt: now, lastSignInAt: now, inactivityWarnedAt: null })
    .where("id", "=", userId)
    .execute();
  return { token, expiresAt };
}
