/**
 * What every procedure of Administration starts from: the base procedure,
 * with the auditor's rule, the parts given apart, the proof, and who may
 * call.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "@anygriddb/core";
import { assertEnrolled } from "../auth/access.js";
import { requireStepUp } from "../auth/step-up.js";
import type { Context } from "./context.js";
import { type RoleNoticeDeps } from "../data/role-notices.js";
import { resolveSmtp } from "../integrations/smtp.js";
import { auditorMayCall } from "./auditor-rule.js";
import { delegatedMayCall } from "./delegation-rule.js";
import { asksProof } from "./proof-rule.js";
import { procedure as baseProcedure, requireUser } from "./init.js";

/** Whether the call under way is one an auditor may make. */
const auditorCall = new AsyncLocalStorage<boolean>();

/** Whether the call under way is one a part given to the caller opens. */
const delegatedCall = new AsyncLocalStorage<boolean>();

/**
 * The base of every procedure of Administration, before the call's input
 * is even read. It says whether the call is one an auditor may make, and
 * refuses an account that is an auditor and nothing more; and whether a
 * part of Administration given to the caller opens it (ADR 0126). Then it
 * asks for the proof (ROADMAP #28): every change does, but the few named
 * in `proof-rule.ts`, so a change added later asks without a word.
 */
export const procedure = baseProcedure.use(
  async ({ ctx, next, type, path }) => {
    const allowed = auditorMayCall(type, path);
    const proof = asksProof(type, path);
    const user = await requireUser(ctx).catch(() => null);
    if (user?.actingAs && path !== "admin.stopActing") {
      throw new AppError("acting_as");
    }
    const delegated =
      user !== null &&
      !ctx.tokenScope &&
      delegatedMayCall(user.instanceRoles, path);
    if (!allowed || proof) {
      // Whoever is not signed in is told so by the procedure itself.
      if (
        !allowed &&
        !delegated &&
        user?.isAuditor &&
        !user.isAdmin &&
        !user.isSupport
      ) {
        throw new AppError("access_denied");
      }
      // Asked of those who may change something here; anyone else, and an
      // API token, is refused by the procedure itself.
      if (
        proof &&
        (user?.isAdmin || user?.isSupport || delegated) &&
        !ctx.tokenScope
      ) {
        await requireStepUp(ctx);
      }
    }
    return auditorCall.run(allowed, () =>
      delegatedCall.run(delegated, () => next()),
    );
  },
);

/** An auditor, on a call an auditor may make. */
function auditing(user: { isAuditor: boolean }): boolean {
  return user.isAuditor && auditorCall.getStore() === true;
}

/** A call a part of Administration given to the caller opens (ADR 0126). */
function delegating(): boolean {
  return delegatedCall.getStore() === true;
}

/**
 * Administration needs an admin's own session, API tokens refused, and a
 * second factor, whatever the policy says of others (ADR 0043). An
 * auditor passes where the call reads (ADR 0071), an account given a part
 * of Administration on the calls that part opens (ADR 0126).
 */
export async function requireAdmin(ctx: Context) {
  const user = await requireUser(ctx);
  if ((!user.isAdmin && !auditing(user) && !delegating()) || ctx.tokenScope) {
    throw new AppError("access_denied");
  }
  await assertEnrolled(ctx.db, user, []);
  return user;
}

/** What telling a base's owners of a role given needs: the app and mail. */
export async function roleNoticeDeps(ctx: Context): Promise<RoleNoticeDeps> {
  const { config: smtp } = await resolveSmtp(ctx.db, ctx.env);
  return {
    db: ctx.db,
    bus: ctx.bus,
    log: (error, message) => ctx.req.log.error({ err: error }, message),
    smtp,
    publicUrl: ctx.env.PUBLIC_URL,
    keys: ctx.env.AUTH_ENCRYPTION_KEY,
  };
}

/**
 * Helpdesk: administrators or support (ADR 0054). Same session and factor
 * rules as requireAdmin; narrower procedures call this instead.
 */
export async function requireSupport(ctx: Context) {
  const user = await requireUser(ctx);
  if (
    (!user.isAdmin && !user.isSupport && !auditing(user) && !delegating()) ||
    ctx.tokenScope
  ) {
    throw new AppError("access_denied");
  }
  await assertEnrolled(ctx.db, user, []);
  return user;
}
