/**
 * What reaches a person (ADR 0131): every attribution given to them or to
 * one of their groups, on a base or a table, that has not ended. A group's
 * attribution is one row; who is in the group is read when it is asked.
 */
import {
  type Binding,
  type Permission,
  ROLES,
  roleGrants,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql, type ExpressionBuilder } from "kysely";
import { bindingsFrom, MADE_COLUMNS } from "./made-roles.js";

/** What a read of attributions selects as `a`, beside `MADE_COLUMNS`. */
const ATTRIBUTION_COLUMNS = [
  "a.role",
  "a.scope",
  "a.scopeId",
  "a.rowFilter",
  "a.fieldAccess",
] as const;

/** An attribution that gives something now: none past its end. */
export function liveAttribution(
  eb: ExpressionBuilder<{ a: { endsAt: Date | null } }, "a">,
) {
  return eb.or([
    eb("a.endsAt", "is", null),
    eb("a.endsAt", ">", sql<Date>`now()`),
  ]);
}

/** For each person, what reaches them now, their groups' included. */
export async function attributionsOf(
  db: Pick<Database, "selectFrom">,
  userIds: readonly string[],
): Promise<Map<string, Binding[]>> {
  const held = new Map<string, Binding[]>();
  if (userIds.length === 0) return held;
  const rows = await db
    .selectFrom("attributions as a")
    .leftJoin("groupMembers as gm", "gm.groupId", "a.groupId")
    .leftJoin("madeRoles as m", "m.id", "a.madeRoleId")
    .select([
      sql<string>`coalesce(a.user_id, gm.user_id)`.as("holder"),
      ...ATTRIBUTION_COLUMNS,
      ...MADE_COLUMNS,
    ])
    .where((eb) =>
      eb.or([eb("a.userId", "in", userIds), eb("gm.userId", "in", userIds)]),
    )
    .where(liveAttribution)
    .execute();
  for (const row of rows) {
    held.set(row.holder, [
      ...(held.get(row.holder) ?? []),
      ...bindingsFrom([row]),
    ]);
  }
  return held;
}

/** What reaches one person now, their groups' included. */
export async function attributionsOfOne(
  db: Pick<Database, "selectFrom">,
  userId: string,
): Promise<Binding[]> {
  return (await attributionsOf(db, [userId])).get(userId) ?? [];
}

/** Rows of `attributions as a` that reach someone: theirs, or a group's they are in. */
function holderOf(
  eb: ExpressionBuilder<
    { a: { userId: string | null; groupId: string | null } },
    "a"
  >,
  userId: string,
) {
  return eb.or([
    eb("a.userId", "=", userId),
    eb(
      "a.groupId",
      "in",
      sql<string>`(select group_id from group_members where user_id = ${userId})`,
    ),
  ]);
}

/** Whether someone holds any role on the base itself, theirs or a group's. */
export async function holdsOnBase(
  db: Pick<Database, "selectFrom">,
  userId: string,
  baseId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("attributions as a")
    .select("a.id")
    .where((eb) => holderOf(eb, userId))
    .where("a.scope", "=", "base")
    .where("a.scopeId", "=", baseId)
    .where(liveAttribution)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Who holds a permission on a base, or on one of its tables, now: by a
 * role of their own or a group's, one of the four or a made role. Whom a
 * notice about the base is for, where `role = 'owner'` once stood.
 */
export async function holdersOf(
  db: Pick<Database, "selectFrom">,
  where: { baseId: string; tableId?: string },
  permission: Permission,
): Promise<string[]> {
  const packs = ROLES.filter((role) => roleGrants(role, permission));
  const rows = await db
    .selectFrom("attributions as a")
    .leftJoin("groupMembers as gm", "gm.groupId", "a.groupId")
    .leftJoin("madeRoles as m", "m.id", "a.madeRoleId")
    .select(sql<string | null>`coalesce(a.user_id, gm.user_id)`.as("userId"))
    .where((eb) =>
      eb.or([
        eb.and([
          eb("a.scope", "=", "base"),
          eb("a.scopeId", "=", where.baseId),
        ]),
        ...(where.tableId === undefined
          ? []
          : [
              eb.and([
                eb("a.scope", "=", "table"),
                eb("a.scopeId", "=", where.tableId),
              ]),
            ]),
      ]),
    )
    .where((eb) =>
      eb.or([
        eb("a.role", "in", packs),
        sql<boolean>`m.permissions ? ${permission}`,
      ]),
    )
    .where(liveAttribution)
    .execute();
  return [
    ...new Set(
      rows.flatMap((row) => (row.userId === null ? [] : [row.userId])),
    ),
  ];
}

/** Everyone who holds a role on a base or one of its tables, theirs or a group's. */
export async function reachersOf(
  db: Pick<Database, "selectFrom">,
  baseId: string,
): Promise<Set<string>> {
  const rows = await db
    .selectFrom("attributions as a")
    .leftJoin("groupMembers as gm", "gm.groupId", "a.groupId")
    .select(sql<string | null>`coalesce(a.user_id, gm.user_id)`.as("userId"))
    .where((eb) =>
      eb.or([
        eb.and([eb("a.scope", "=", "base"), eb("a.scopeId", "=", baseId)]),
        eb.and([
          eb("a.scope", "=", "table"),
          eb(
            "a.scopeId",
            "in",
            eb
              .selectFrom("dataTables")
              .select("id")
              .where("baseId", "=", baseId),
          ),
        ]),
      ]),
    )
    .where(liveAttribution)
    .execute();
  return new Set(
    rows.flatMap((row) => (row.userId === null ? [] : [row.userId])),
  );
}
