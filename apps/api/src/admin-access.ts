/**
 * An account's effective rights on a base and its tables (ROADMAP #29):
 * the resolved role the engine would use, and whether it comes from the
 * person's own binding or from a group.
 */
import {
  AppError,
  effectiveTableRole,
  roleFor,
  roleRank,
  type Role,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { ERASED_USER_ID } from "./data/erasure.js";
import { liveBase, liveTable } from "./data/live.js";

export const effectiveAccessInputSchema = z
  .object({
    userId: z.uuid(),
    baseId: z.uuid(),
  })
  .strict();

type AccessOrigin =
  | { kind: "direct" }
  | { kind: "group"; groupId: string; groupName: string }
  | { kind: "none" };

type SourcedBinding = {
  role: Role;
  scope: "base" | "table";
  scopeId: string;
  groupId: string | null;
  groupName: string | null;
};

/**
 * Among bindings on one exact scope, the highest role and where it comes
 * from. A person's own binding wins a tie with a group's.
 */
function resolvedOn(
  bindings: readonly SourcedBinding[],
  scope: "base" | "table",
  scopeId: string,
): { role: Role | null; origin: AccessOrigin } {
  let best: Role | null = null;
  let origin: AccessOrigin = { kind: "none" };
  for (const binding of bindings) {
    if (binding.scope !== scope || binding.scopeId !== scopeId) continue;
    const rank = roleRank(binding.role);
    const bestRank = best ? roleRank(best) : 0;
    const direct = binding.groupId === null;
    const better =
      rank > bestRank ||
      (rank === bestRank && direct && origin.kind !== "direct");
    if (!better) continue;
    best = binding.role;
    if (direct || binding.groupId === null) {
      origin = { kind: "direct" };
    } else {
      origin = {
        kind: "group",
        groupId: binding.groupId,
        groupName: binding.groupName ?? "",
      };
    }
  }
  return { role: best, origin };
}

/**
 * The role the engine would grant this account on the base and on each of
 * its tables, with the origin of that role (own binding or group name).
 */
export async function effectiveAccess(
  db: Database,
  input: z.input<typeof effectiveAccessInputSchema>,
) {
  const { userId, baseId } = effectiveAccessInputSchema.parse(input);
  if (userId === ERASED_USER_ID) throw new AppError("invalid_account");
  const [account, base] = await Promise.all([
    db
      .selectFrom("users")
      .select(["id", "displayName", "email"])
      .where("id", "=", userId)
      .executeTakeFirst(),
    db
      .selectFrom("bases")
      .select(["id", "name"])
      .where("id", "=", baseId)
      .where(liveBase())
      .executeTakeFirst(),
  ]);
  if (!account) throw new AppError("unknown_account");
  if (!base) throw new AppError("unknown_base");

  const [bindings, tables] = await Promise.all([
    db
      .selectFrom("roleBindings as b")
      .leftJoin("groups as g", "g.id", "b.groupId")
      .select([
        "b.role",
        "b.scope",
        "b.scopeId",
        "b.groupId",
        "g.displayName as groupName",
      ])
      .where("b.userId", "=", userId)
      .where("b.scope", "in", ["base", "table"])
      .execute(),
    db
      .selectFrom("dataTables")
      .select(["id", "name"])
      .where("baseId", "=", baseId)
      .where(liveTable())
      .orderBy("name")
      .execute(),
  ]);

  const sourced: SourcedBinding[] = bindings.map((row) => ({
    role: row.role,
    scope: row.scope as "base" | "table",
    scopeId: row.scopeId,
    groupId: row.groupId,
    groupName: row.groupName,
  }));

  // Same plain bindings the engine loads for can() / effectiveTableRole.
  const plain = sourced.map(({ role, scope, scopeId }) => ({
    role,
    scope,
    scopeId,
  }));

  const onBase = resolvedOn(sourced, "base", baseId);
  // roleFor is what the engine uses; keep it as the source of truth.
  const baseRole = roleFor(plain, "base", baseId);

  return {
    userId: account.id,
    displayName: account.displayName,
    email: account.email,
    baseId: base.id,
    baseName: base.name,
    role: baseRole,
    origin: baseRole === null ? ({ kind: "none" } as const) : onBase.origin,
    tables: tables.map((table) => {
      const onTable = resolvedOn(sourced, "table", table.id);
      const engineRole = effectiveTableRole(plain, table.id, baseId);
      const overridden = onTable.role !== null;
      const origin: AccessOrigin = overridden
        ? onTable.origin
        : baseRole === null
          ? { kind: "none" }
          : onBase.origin;
      return {
        tableId: table.id,
        tableName: table.name,
        role: engineRole,
        origin,
        overridden,
      };
    }),
  };
}
