import {
  AppError,
  type Binding,
  effectiveTableRole,
  type Permission,
  type Role,
  roleFor,
  roleGrants,
} from "@anygriddb/core";
import { assertEnrolled, loadBindings, scopeBindings } from "../auth/access.js";
import { type SessionUser, withActingRights } from "../auth/session.js";
import { readGateSettings } from "../settings.js";
import type { TableRow } from "../data/engine.js";
import { sessionBindings } from "../data/emergency-access.js";
import { liveBase } from "../data/live.js";
import { findLiveTable } from "../services/rows.js";
import type { Context } from "./context.js";
import { requireUser, sharedLookup } from "./init.js";
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

/**
 * Session or token user, their bindings, and the MFA gate. The procedures
 * of one request that ask at the same moment share one answer.
 */
export function authorize(ctx: Context, creatingBase = false): Promise<Actor> {
  return sharedLookup(ctx, creatingBase ? "actor:base" : "actor", () =>
    findActor(ctx, creatingBase),
  );
}

async function findActor(ctx: Context, creatingBase: boolean): Promise<Actor> {
  const account = await requireUser(ctx);
  const user = withActingRights(account);
  if (
    creatingBase &&
    !user.isAdmin &&
    (await readGateSettings(ctx.db)).baseCreation === "admins"
  ) {
    throw new AppError("base_creation_restricted");
  }
  const raw = await loadBindings(ctx.db, user.actingAs?.id ?? user.id);
  await assertEnrolled(ctx.db, account, raw, creatingBase);
  if (
    creatingBase &&
    ctx.tokenScope &&
    (ctx.tokenScope.baseIds || ctx.tokenScope.readOnly)
  ) {
    throw new AppError("access_denied");
  }
  // A person's own session also reads the bases they have open as an
  // administrator (ADR 0074); a token keeps to the account's roles.
  const own = ctx.tokenScope
    ? raw
    : await sessionBindings(
        ctx.db,
        user.actingAs ? { id: user.actingAs.id, isAdmin: false } : user,
        raw,
      );
  return { user, bindings: await scopeBindings(ctx.db, own, ctx.tokenScope) };
}

/**
 * Authenticated caller who already satisfies the instance MFA policy.
 * Use for personal surfaces (notifications, shortcuts) that must not
 * bypass enrollment the way `requireUser` alone would.
 */
export async function requireEnrolledUser(ctx: Context): Promise<SessionUser> {
  return (await authorize(ctx)).user;
}

/**
 * A table that is not there is refused as one the caller has no role on:
 * another answer would tell someone with no right whether an id names
 * anything. The screens say both in one sentence.
 */
async function loadTable(ctx: Context, tableId: string): Promise<TableRow> {
  // A table in the trash, or in a base in the trash, reads as missing.
  const table = await findLiveTable(ctx.db, tableId);
  if (!table) {
    throw new AppError("access_denied");
  }
  return table;
}

export type TableAccess = Actor & { table: TableRow; role: Role };

/**
 * For an act that needs a second permission besides the one its guard
 * asked (a base's public link is the base's and a publication; its
 * snapshot is the base's and an export): refused as the guard refuses.
 */
export function assertGrants(role: Role, permission: Permission): void {
  if (!roleGrants(role, permission)) {
    throw new AppError("access_denied");
  }
}

/** Authorizes `permission` on a table, with the base role as fallback. */
export async function guardTable(
  ctx: Context,
  tableId: string,
  permission: Permission,
): Promise<TableAccess> {
  return tableAccess(ctx, await authorize(ctx), tableId, permission);
}

/**
 * The same, for a caller already asked who they are. A procedure given the
 * id of something a table holds (a view, a webhook, a comment) asks
 * `authorize` first, finds the table, then comes here: someone who is not
 * signed in is told so, and nothing of whether the id names anything.
 */
export async function tableAccess(
  ctx: Context,
  actor: Actor,
  tableId: string,
  permission: Permission,
): Promise<TableAccess> {
  const table = await loadTable(ctx, tableId);
  const role = effectiveTableRole(actor.bindings, table.id, table.baseId);
  if (!role || !roleGrants(role, permission)) {
    throw new AppError("access_denied");
  }
  return { ...actor, table, role };
}

export async function guardBase(
  ctx: Context,
  baseId: string,
  permission: Permission,
  creatingBase = false,
): Promise<Actor & { role: Role }> {
  return baseAccess(
    ctx,
    await authorize(ctx, creatingBase),
    baseId,
    permission,
  );
}

/** The same, for a caller already asked who they are: see `tableAccess`. */
export async function baseAccess(
  ctx: Context,
  actor: Actor,
  baseId: string,
  permission: Permission,
): Promise<Actor & { role: Role }> {
  const base = await ctx.db
    .selectFrom("bases")
    .select("id")
    .where("id", "=", baseId)
    .where(liveBase())
    .executeTakeFirst();
  // As for a table: a base that is not there is one the caller has no
  // role on.
  if (!base) {
    throw new AppError("access_denied");
  }
  const role = roleFor(actor.bindings, "base", baseId);
  if (!role || !roleGrants(role, permission)) {
    throw new AppError("access_denied");
  }
  return { ...actor, role };
}
