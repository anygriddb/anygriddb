import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { factorMethods } from "./access.js";
import { verifyPassword } from "./argon2.js";
import { consumeBackupCode } from "./backup-store.js";
import type { KeyRing } from "./key-ring.js";
import { hashSessionToken, isSessionToken, SESSION_COOKIE } from "./session.js";
import { sessionStartedAt } from "./erase-proof.js";
import { consumeTotpCode } from "./totp.js";
import type { Context } from "../trpc/context.js";

/** How long a proved step-up stays fresh for sensitive Administration acts. */
export const FRESH_STEP_UP_MS = 5 * 60_000;

/**
 * What proving a step-up found: `missing` when a proof was left out,
 * `wrong` when one was given and is not the account's, `stale` when an
 * account that signs in through its provider alone and has only a passkey
 * needs a sign-in less than five minutes old.
 */
type StepUpProof = "ok" | "missing" | "wrong" | "stale";

/**
 * Password or second factor asked again before a sensitive Administration
 * action (ROADMAP #28, SEC-13). An account with a password may prove with
 * it, or with its authenticator code when enrolled. An account that signs
 * in only through a provider proves with the authenticator or a backup
 * code when enrolled; with only a passkey, a sign-in less than five
 * minutes old stands (the same rule erasing one's own account uses for a
 * passkey, with the step-up window).
 */
export async function proveStepUp(
  db: Database,
  key: KeyRing,
  input: {
    userId: string;
    startedAt: Date | null;
    proof: { password?: string | undefined; factorCode?: string | undefined };
    now?: Date;
  },
): Promise<StepUpProof> {
  const { userId, proof } = input;
  const stored = await db
    .selectFrom("passwordHashes")
    .select("hash")
    .where("userId", "=", userId)
    .executeTakeFirst();
  const methods = await factorMethods(db, userId);
  const hasTotp = methods.includes("totp");
  const hasPasskey = methods.includes("webauthn");
  const offeredPassword = proof.password !== undefined;
  const offeredCode = proof.factorCode !== undefined;

  if (stored && offeredPassword) {
    if (!(await verifyPassword(stored.hash, proof.password ?? ""))) {
      return "wrong";
    }
    return "ok";
  }
  if (hasTotp && offeredCode) {
    const given = proof.factorCode ?? "";
    const accepted =
      (await consumeTotpCode(db, userId, given, key)) ||
      (await consumeBackupCode(db, userId, given, key));
    if (!accepted) return "wrong";
    return "ok";
  }

  // SSO (or passkey-only) with no password and no TOTP: the recent sign-in.
  if (!stored && !hasTotp && hasPasskey) {
    if (offeredPassword || offeredCode) return "wrong";
    const age =
      input.startedAt === null
        ? Number.POSITIVE_INFINITY
        : (input.now ?? new Date()).getTime() - input.startedAt.getTime();
    if (age > FRESH_STEP_UP_MS) return "stale";
    return "ok";
  }

  if (!offeredPassword && !offeredCode) return "missing";
  return "wrong";
}

/** Marks the current session as stepped up just now. */
async function stampStepUp(
  db: Database,
  token: string | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  if (!isSessionToken(token)) return false;
  const updated = await db
    .updateTable("sessions")
    .set({ steppedUpAt: now })
    .where("tokenHash", "=", hashSessionToken(token))
    .where("expiresAt", ">", now)
    .executeTakeFirst();
  return Number(updated.numUpdatedRows) > 0;
}

/** Whether the current session's step-up is still within the fresh window. */
export async function stepUpIsFresh(
  db: Database,
  token: string | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  if (!isSessionToken(token)) return false;
  const row = await db
    .selectFrom("sessions")
    .select("steppedUpAt")
    .where("tokenHash", "=", hashSessionToken(token))
    .where("expiresAt", ">", now)
    .executeTakeFirst();
  if (!row?.steppedUpAt) return false;
  return now.getTime() - row.steppedUpAt.getTime() <= FRESH_STEP_UP_MS;
}

/**
 * Refuses an API token and a session whose step-up is older than five
 * minutes (or never proved). Wire on sensitive Administration mutations.
 */
export async function requireStepUp(ctx: Context): Promise<void> {
  if (ctx.tokenScope) throw new AppError("access_denied");
  const token = ctx.req.cookies[SESSION_COOKIE];
  if (!(await stepUpIsFresh(ctx.db, token))) {
    throw new AppError("step_up_required");
  }
}

/** Proves the step-up for this request's session and stamps it. */
export async function confirmStepUp(
  ctx: Context,
  userId: string,
  proof: { password?: string | undefined; factorCode?: string | undefined },
): Promise<StepUpProof> {
  if (ctx.tokenScope) throw new AppError("access_denied");
  const token = ctx.req.cookies[SESSION_COOKIE];
  const startedAt = await sessionStartedAt(ctx.db, token);
  const proved = await proveStepUp(ctx.db, ctx.env.AUTH_ENCRYPTION_KEY, {
    userId,
    startedAt,
    proof,
  });
  if (proved === "ok") {
    await stampStepUp(ctx.db, token);
  }
  return proved;
}

/** What the page asks before a sensitive Administration action. */
export async function stepUpNeeds(
  db: Database,
  userId: string,
): Promise<"password" | "code" | "sign_in"> {
  const stored = await db
    .selectFrom("passwordHashes")
    .select("userId")
    .where("userId", "=", userId)
    .executeTakeFirst();
  if (stored) return "password";
  const methods = await factorMethods(db, userId);
  if (methods.includes("totp")) return "code";
  return "sign_in";
}
