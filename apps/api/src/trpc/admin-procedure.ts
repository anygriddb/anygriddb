/**
 * What every procedure of Administration starts from: the base procedure,
 * with the auditor's rule, the parts of Administration, the proof, and who
 * may call.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  AppError,
  callersHold,
  type InstanceCaller,
  instanceCallers,
  type InstancePermission,
  isInstancePermission,
} from "@anygriddb/core";
import { assertEnrolled } from "../auth/access.js";
import { requireStepUp } from "../auth/step-up.js";
import type { Context } from "./context.js";
import { type RoleNoticeDeps } from "../data/role-notices.js";
import { resolveSmtp } from "../integrations/smtp.js";
import { type Declaration } from "../access/declaration.js";
import { asksProof } from "./proof-rule.js";
import { baseProcedure, requireUser } from "./init.js";

/** Whether the call under way is one an auditor may make. */
const auditorCall = new AsyncLocalStorage<boolean>();

/** Whether what the caller is opens the call under way. */
const openCall = new AsyncLocalStorage<boolean>();

/** The permissions of Administration a procedure asks on every call. */
function instanceAsks(declaration: Declaration): InstancePermission[] {
  return (declaration.asks ?? []).filter(isInstancePermission);
}

/**
 * Whether what the caller is opens a procedure: they hold every
 * permission of Administration it asks. One that asks none (the proof) is
 * open to whoever holds a part of Administration. An auditor's reading is
 * the auditor's rule, apart.
 */
export function partsOpen(
  callers: readonly InstanceCaller[],
  declaration: Declaration,
): boolean {
  const own = callers.filter((caller) => caller !== "auditor");
  const asked = instanceAsks(declaration);
  if (asked.length === 0) return own.length > 0;
  return asked.every((permission) => callersHold(own, permission));
}

/**
 * The auditor's rule, whole (ADR 0071): every read of Administration but
 * what reaches out to a client's database, and the exports the auditor
 * holds. It goes by what a procedure is: a read added later is open to
 * the auditor without a word, a change refused.
 */
export function auditorOpen(
  type: "query" | "mutation" | "subscription",
  declaration: Declaration,
): boolean {
  const asked = instanceAsks(declaration);
  if (type === "query") return !asked.includes("sources.browse");
  return (
    asked.length > 0 &&
    asked.every((permission) => callersHold(["auditor"], permission))
  );
}

/**
 * The base of every procedure of Administration, before the call's input
 * is even read. It refuses an account that is an auditor and nothing more
 * on a call the auditor's rule does not open; then it asks for the proof
 * (ROADMAP #28) of whoever the call is open to: every change does, but
 * the few named in `proof-rule.ts`.
 */
const adminProcedure = baseProcedure.use(
  async ({ ctx, next, type, path, meta }) => {
    const declaration = meta ?? {};
    const allowed = auditorOpen(type, declaration);
    const proof = asksProof(type, path);
    const user = await requireUser(ctx).catch(() => null);
    if (user?.actingAs && path !== "admin.stopActing") {
      throw new AppError("acting_as");
    }
    const opens =
      user !== null &&
      !ctx.tokenScope &&
      partsOpen(instanceCallers(user), declaration);
    // Whoever is not signed in is told so by the procedure itself.
    if (!allowed && !opens && user?.isAuditor) {
      throw new AppError("access_denied");
    }
    // Asked of those the call is open to; anyone else, and an API token,
    // is refused by the procedure itself.
    if (proof && opens) await requireStepUp(ctx);
    return auditorCall.run(allowed, () => openCall.run(opens, () => next()));
  },
);

/**
 * A procedure of Administration, with the permissions of Administration
 * it asks (`access/declaration.ts`).
 */
export function asking(declaration: Declaration) {
  return adminProcedure.meta(declaration);
}

/**
 * Administration needs an account's own session, API tokens refused, a
 * second factor whatever the policy says of others (ADR 0043), and what
 * the procedure asks: held by the caller, or read by an auditor where the
 * auditor's rule opens it (ADR 0071).
 */
export async function requireInstance(ctx: Context) {
  const user = await requireUser(ctx);
  const opened =
    openCall.getStore() === true ||
    (user.isAuditor && auditorCall.getStore() === true);
  if (!opened || ctx.tokenScope) {
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
