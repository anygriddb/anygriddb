/**
 * What every procedure of Administration starts from: the base procedure,
 * with the auditor's rule and the proof, and who may call.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "@anygriddb/core";
import { assertEnrolled } from "../auth/access.js";
import { requireStepUp } from "../auth/step-up.js";
import type { Context } from "./context.js";
import { type RoleNoticeDeps } from "../data/role-notices.js";
import { auditorMayCall } from "./auditor-rule.js";
import { asksProof } from "./proof-rule.js";
import { procedure as baseProcedure, requireUser } from "./init.js";

/** Whether the call under way is one an auditor may make. */
const auditorCall = new AsyncLocalStorage<boolean>();

/**
 * The base of every procedure of Administration, before the call's input
 * is even read. It says whether the call is one an auditor may make, and
 * refuses an account that is an auditor and nothing more. Then it asks
 * for the proof (ROADMAP #28): every change does, but the few named in
 * `proof-rule.ts`, so a change added later asks without a word.
 */
export const procedure = baseProcedure.use(
  async ({ ctx, next, type, path }) => {
    const allowed = auditorMayCall(type, path);
    const proof = asksProof(type, path);
    if (!allowed || proof) {
      // Whoever is not signed in is told so by the procedure itself.
      const user = await requireUser(ctx).catch(() => null);
      if (!allowed && user?.isAuditor && !user.isAdmin && !user.isSupport) {
        throw new AppError("access_denied");
      }
      // Asked of those who may change something here; anyone else, and an
      // API token, is refused by the procedure itself.
      if (proof && (user?.isAdmin || user?.isSupport) && !ctx.tokenScope) {
        await requireStepUp(ctx);
      }
    }
    return auditorCall.run(allowed, () => next());
  },
);

/** An auditor, on a call an auditor may make. */
function auditing(user: { isAuditor: boolean }): boolean {
  return user.isAuditor && auditorCall.getStore() === true;
}

/**
 * Administration needs an admin's own session, API tokens refused, and a
 * second factor, whatever the policy says of others (ADR 0043). An
 * auditor passes where the call reads (ADR 0071).
 */
export async function requireAdmin(ctx: Context) {
  const user = await requireUser(ctx);
  if ((!user.isAdmin && !auditing(user)) || ctx.tokenScope) {
    throw new AppError("access_denied");
  }
  await assertEnrolled(ctx.db, user, []);
  return user;
}

/** What telling a base's owners of a role given needs: the app. */
export function roleNoticeDeps(ctx: Context): RoleNoticeDeps {
  return {
    db: ctx.db,
    bus: ctx.bus,
    log: (error, message) => ctx.req.log.error({ err: error }, message),
  };
}

/**
 * Helpdesk: administrators or support (ADR 0054). Same session and factor
 * rules as requireAdmin; narrower procedures call this instead.
 */
export async function requireSupport(ctx: Context) {
  const user = await requireUser(ctx);
  if ((!user.isAdmin && !user.isSupport && !auditing(user)) || ctx.tokenScope) {
    throw new AppError("access_denied");
  }
  await assertEnrolled(ctx.db, user, []);
  return user;
}
