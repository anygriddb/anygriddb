import {
  type Action,
  AppError,
  type Binding,
  effectiveTableRole,
  type Role,
  roleAllows,
  roleFor,
} from "@anygriddb/core";
import { TRPCError } from "@trpc/server";
import { assertEnrolled, loadBindings, scopeBindings } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { readGateSettings } from "../settings.js";
import type { TableRow } from "../data/engine.js";
import { liveBase } from "../data/live.js";
import { findLiveTable } from "../services/rows.js";
import type { Context } from "./context.js";
import { requireUser } from "./init.js";
import { mapProcedureError } from "./map-error.js";

export type Actor = { user: SessionUser; bindings: Binding[] };

/** Runs a procedure body and maps its failure to a public tRPC error. */
export async function handle<T>(
  ctx: Context,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (error) {
    mapProcedureError(error, ctx.req.log);
  }
}

/** Session or token user, their bindings, and the MFA gate. */
export async function authorize(
  ctx: Context,
  creatingBase = false,
): Promise<Actor> {
  const user = await requireUser(ctx);
  if (
    creatingBase &&
    !user.isAdmin &&
    (await readGateSettings(ctx.db)).baseCreation === "admins"
  ) {
    throw new AppError("base_creation_restricted");
  }
  const raw = await loadBindings(ctx.db, user.id);
  await assertEnrolled(ctx.db, user, raw, creatingBase);
  if (
    creatingBase &&
    ctx.tokenScope &&
    (ctx.tokenScope.baseIds || ctx.tokenScope.readOnly)
  ) {
    throw new AppError("access_denied");
  }
  return { user, bindings: await scopeBindings(ctx.db, raw, ctx.tokenScope) };
}

/**
 * Authenticated caller who already satisfies the instance MFA policy.
 * Use for personal surfaces (notifications, shortcuts) that must not
 * bypass enrollment the way `requireUser` alone would.
 */
export async function requireEnrolledUser(ctx: Context): Promise<SessionUser> {
  return (await authorize(ctx)).user;
}

export async function loadTable(
  ctx: Context,
  tableId: string,
): Promise<TableRow> {
  // A table in the trash, or in a base in the trash, reads as missing.
  const table = await findLiveTable(ctx.db, tableId);
  if (!table) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  return table;
}

/** Predicate the read engine uses to hide linked tables the actor cannot read. */
export function readableTables(
  bindings: readonly Binding[],
  baseOf: ReadonlyMap<string, string>,
): (tableId: string) => boolean {
  return (tableId) =>
    roleAllows(
      effectiveTableRole(bindings, tableId, baseOf.get(tableId)),
      "read",
    );
}

export type TableAccess = Actor & { table: TableRow; role: Role };

/** Authorizes `action` on a table, with the base role as fallback. */
export async function guardTable(
  ctx: Context,
  tableId: string,
  action: Action,
): Promise<TableAccess> {
  const actor = await authorize(ctx);
  const table = await loadTable(ctx, tableId);
  const role = effectiveTableRole(actor.bindings, table.id, table.baseId);
  if (!role || !roleAllows(role, action)) {
    throw new AppError("access_denied");
  }
  return { ...actor, table, role };
}

export async function guardBase(
  ctx: Context,
  baseId: string,
  action: Action,
  creatingBase = false,
): Promise<Actor & { role: Role }> {
  const actor = await authorize(ctx, creatingBase);
  const base = await ctx.db
    .selectFrom("bases")
    .select("id")
    .where("id", "=", baseId)
    .where(liveBase())
    .executeTakeFirst();
  if (!base) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  const role = roleFor(actor.bindings, "base", baseId);
  if (!role || !roleAllows(role, action)) {
    throw new AppError("access_denied");
  }
  return { ...actor, role };
}
