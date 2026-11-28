/**
 * An account's effective rights on a base and its tables (ROADMAP #29, ADR
 * 0131): every permission it holds there and the attributions it comes
 * from, its own or a group's, on the base or the table, until when, and
 * what a rule narrows.
 */
import {
  AppError,
  type Binding,
  effectiveTableRole,
  type Given,
  type Permission,
  PERMISSIONS,
  roleFor,
  roleGrants,
  tableRules,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { liveAttribution } from "./data/attributions.js";
import { ERASED_USER_ID } from "./data/erasure.js";
import { liveBase, liveTable } from "./data/live.js";
import {
  fieldRowsOf,
  fieldsOf,
  givenKey,
  givenName,
  givenOf,
  MADE_COLUMNS,
  rowsOf,
} from "./data/made-roles.js";

export const effectiveAccessInputSchema = z
  .object({
    userId: z.uuid(),
    baseId: z.uuid(),
  })
  .strict();

/** One attribution that reaches a person, as Administration shows it. */
export type AccessOrigin = {
  scope: "base" | "table";
  /** One of the shipped roles by its key, or a made role by its id. */
  role: string;
  /** A made role's name; null for a shipped role. */
  madeName: string | null;
  /** The group it is given to; null when it is the person's own. */
  group: { id: string; name: string } | null;
  endsAt: string | null;
  /** Whether a rule comes with it (to some rows or fields). */
  narrows: boolean;
};

/** An origin with what the decision reads of it. */
export type SourcedOrigin = AccessOrigin & { binding: Binding };

/**
 * What the attributions that reach one scope give together: each
 * permission with the attributions it comes from (by their place in
 * `origins`).
 */
export function rightsOn(origins: ReadonlyArray<SourcedOrigin>): {
  origins: AccessOrigin[];
  permissions: Array<{ permission: Permission; from: number[] }>;
} {
  return {
    origins: origins.map(({ binding: _binding, ...origin }) => origin),
    permissions: PERMISSIONS.flatMap((permission) => {
      const from = origins.flatMap((origin, index) =>
        roleGrants(origin.binding.role, permission) ? [index] : [],
      );
      return from.length > 0 ? [{ permission, from }] : [];
    }),
  };
}

/**
 * Every permission this account holds on the base and on each of its
 * tables, and the attributions that give it, as the decision reads them.
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

  const [rows, tables] = await Promise.all([
    db
      .selectFrom("attributions as a")
      .leftJoin("groups as g", "g.id", "a.groupId")
      .leftJoin("madeRoles as m", "m.id", "a.madeRoleId")
      .select([
        "a.role",
        "a.scope",
        "a.scopeId",
        "a.groupId",
        "a.endsAt",
        "a.rowFilter",
        "a.fieldAccess",
        "g.displayName as groupName",
        ...MADE_COLUMNS,
      ])
      .where((eb) =>
        eb.or([
          eb("a.userId", "=", userId),
          eb(
            "a.groupId",
            "in",
            eb
              .selectFrom("groupMembers")
              .select("groupId")
              .where("userId", "=", userId),
          ),
        ]),
      )
      .where("a.scope", "in", ["base", "table"])
      .where(liveAttribution)
      .execute(),
    db
      .selectFrom("dataTables")
      .select(["id", "name"])
      .where("baseId", "=", baseId)
      .where(liveTable())
      .orderBy("name")
      .execute(),
  ]);

  const sourced: SourcedOrigin[] = rows.flatMap((row) => {
    const role: Given | null = givenOf(row);
    if (role === null || row.scopeId === null) return [];
    if (row.scope !== "base" && row.scope !== "table") return [];
    const rule = rowsOf(row.rowFilter);
    const fields = fieldsOf(row.fieldAccess);
    const fieldRows = fieldRowsOf(row.fieldAccess);
    return [
      {
        scope: row.scope,
        role: givenKey(role) ?? "",
        madeName: typeof role === "string" ? null : givenName(role),
        group:
          row.groupId === null
            ? null
            : { id: row.groupId, name: row.groupName ?? "" },
        endsAt: row.endsAt ? new Date(row.endsAt).toISOString() : null,
        narrows: rule !== null || fields !== null,
        binding: {
          role,
          scope: row.scope,
          scopeId: row.scopeId,
          ...(rule ? { rows: rule } : {}),
          ...(fields ? { fields } : {}),
          ...(fieldRows ? { fieldRows } : {}),
        },
      },
    ];
  });
  // The base's before a table's, a person's own before a group's: the
  // permissions name their origins by place.
  sourced.sort(
    (one, other) =>
      Number(one.scope === "table") - Number(other.scope === "table") ||
      Number(one.group !== null) - Number(other.group !== null) ||
      (one.group?.name ?? "").localeCompare(other.group?.name ?? "") ||
      (one.madeName ?? one.role).localeCompare(other.madeName ?? other.role),
  );
  const onBase = sourced.filter(
    (origin) => origin.scope === "base" && origin.binding.scopeId === baseId,
  );
  const bindings = sourced.map((origin) => origin.binding);

  return {
    userId: account.id,
    displayName: account.displayName,
    email: account.email,
    baseId: base.id,
    baseName: base.name,
    role: roleFor(bindings, "base", baseId),
    ...rightsOn(onBase),
    tables: tables.map((table) => {
      const onTable = sourced.filter(
        (origin) =>
          origin.scope === "table" && origin.binding.scopeId === table.id,
      );
      const rules = tableRules(bindings, table.id, baseId);
      return {
        tableId: table.id,
        tableName: table.name,
        role: effectiveTableRole(bindings, table.id, baseId),
        /** Whether the table adds an attribution of its own to the base's. */
        overridden: onTable.length > 0,
        ...rightsOn([...onBase, ...onTable]),
        narrowed: rules?.narrows ? rules.narrowed : null,
      };
    }),
  };
}
