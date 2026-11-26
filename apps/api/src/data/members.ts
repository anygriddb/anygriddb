import {
  AppError,
  type Binding,
  type Given,
  givenRoleSchema,
  roleFor,
  rolePermissions,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { z } from "zod";
import { liveAttribution } from "./attributions.js";
import { withAudit, type AuditTx } from "./audit-context.js";
import { liveBase } from "./live.js";
import {
  bindingsFrom,
  givenColumns,
  givenOf,
  MADE_COLUMNS,
} from "./made-roles.js";

export const grantInputSchema = z.object({
  baseId: z.uuid(),
  email: z.email().max(254),
  role: givenRoleSchema,
});

export const revokeInputSchema = z.object({
  baseId: z.uuid(),
  userId: z.uuid(),
});

export const membersInputSchema = z.object({
  baseId: z.uuid(),
});

async function tableIds(db: Database, baseId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("dataTables")
    .select("id")
    .where("baseId", "=", baseId)
    .execute();
  return rows.map((row) => row.id);
}

/** Who owns the base, by their own role or a group's. */
async function ownerIds(db: Database, baseId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("attributions as a")
    .leftJoin("groupMembers as gm", "gm.groupId", "a.groupId")
    .select(sql<string | null>`coalesce(a.user_id, gm.user_id)`.as("userId"))
    .where("a.scope", "=", "base")
    .where("a.scopeId", "=", baseId)
    .where("a.role", "=", "owner")
    .where(liveAttribution)
    .execute();
  return [
    ...new Set(
      rows.flatMap((row) => (row.userId === null ? [] : [row.userId])),
    ),
  ];
}

/** Live bases this account alone owns, by its own role. */
export async function soleOwnerBases(
  db: Database,
  userId: string,
): Promise<{ id: string; name: string }[]> {
  return db
    .selectFrom("bases as b")
    .innerJoin("attributions as own", (join) =>
      join
        .onRef("own.scopeId", "=", "b.id")
        .on("own.scope", "=", "base")
        .on("own.role", "=", "owner")
        .on("own.userId", "=", userId),
    )
    .select(["b.id", "b.name"])
    .where(liveBase("b"))
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("attributions as other")
            .leftJoin("groupMembers as gm", "gm.groupId", "other.groupId")
            .select("other.id")
            .whereRef("other.scopeId", "=", "b.id")
            .where("other.scope", "=", "base")
            .where("other.role", "=", "owner")
            .where(
              sql<boolean>`coalesce(other.user_id, gm.user_id) <> ${userId}`,
            ),
        ),
      ),
    )
    .orderBy("b.name", "asc")
    .execute();
}

/**
 * Gives an account one role on a base, in the caller's audited
 * transaction (ADR 0131): it replaces their own role on the base, and the
 * roles of their own on its tables that give nothing more go. A role on a
 * table that gives more stays, with its rules. A group's roles follow the
 * group, not this choice.
 */
export async function bindRole(
  tx: AuditTx,
  userId: string,
  role: Given,
  baseId: string,
  givenBy?: string,
): Promise<void> {
  await tx
    .deleteFrom("attributions")
    .where("userId", "=", userId)
    .where("scope", "=", "base")
    .where("scopeId", "=", baseId)
    .execute();
  const onTables = await tx
    .selectFrom("attributions as a")
    .innerJoin("dataTables as t", "t.id", "a.scopeId")
    .leftJoin("madeRoles as m", "m.id", "a.madeRoleId")
    .select(["a.id", "a.role", ...MADE_COLUMNS])
    .where("a.userId", "=", userId)
    .where("a.scope", "=", "table")
    .where("t.baseId", "=", baseId)
    .execute();
  const given = new Set(rolePermissions(role));
  const covered = onTables.flatMap((row) => {
    const held = givenOf(row);
    return held === null ||
      rolePermissions(held).every((permission) => given.has(permission))
      ? [row.id]
      : [];
  });
  if (covered.length > 0) {
    await tx.deleteFrom("attributions").where("id", "in", covered).execute();
  }
  await tx
    .insertInto("attributions")
    .values({
      userId,
      ...givenColumns(role),
      scope: "base",
      scopeId: baseId,
      givenBy: givenBy ?? null,
    })
    .execute();
}

/**
 * The base's owners, its row held until the transaction ends: two changes
 * to one base's members wait for each other, so neither can leave it
 * without an owner while each thought the other one stayed.
 */
async function lockedOwners(tx: AuditTx, baseId: string): Promise<string[]> {
  await tx
    .selectFrom("bases")
    .select("id")
    .where("id", "=", baseId)
    .forUpdate()
    .execute();
  return ownerIds(tx, baseId);
}

/**
 * Gives an account one role on a base, or changes it, in an audited
 * transaction under the actor's name. A base keeps an owner: its last
 * one cannot be given another role. Says who owned the base before.
 */
export async function setMemberRole(
  db: Database,
  actorId: string,
  input: { baseId: string; userId: string; role: Given },
  /** Kept on the change trail with the role given. */
  reason?: string,
): Promise<{ owners: string[]; previous: Given | null }> {
  return withAudit(
    db,
    { userId: actorId, source: "web", reason },
    async (tx) => {
      const owners = await lockedOwners(tx, input.baseId);
      if (
        input.role !== "owner" &&
        owners.includes(input.userId) &&
        owners.length < 2
      ) {
        throw new AppError("invalid_owner");
      }
      // The role of their own they had before: a role set again is no news.
      const before = await tx
        .selectFrom("attributions as a")
        .leftJoin("madeRoles as m", "m.id", "a.madeRoleId")
        .select(["a.role", ...MADE_COLUMNS])
        .where("a.userId", "=", input.userId)
        .where("a.scope", "=", "base")
        .where("a.scopeId", "=", input.baseId)
        .executeTakeFirst();
      await bindRole(tx, input.userId, input.role, input.baseId, actorId);
      return { owners, previous: before ? givenOf(before) : null };
    },
  );
}

/**
 * Gives someone their own role on a base table by table (ADR 0131): the
 * same role on each of its tables where they hold none of their own, the
 * trashed ones included, and none on the base. A rule may then narrow one
 * table alone. The base keeps an owner.
 */
export async function splitBaseRole(
  db: Database,
  actorId: string,
  input: { baseId: string; userId: string },
): Promise<void> {
  await withAudit(db, { userId: actorId, source: "web" }, async (tx) => {
    const owners = await lockedOwners(tx, input.baseId);
    const own = await tx
      .selectFrom("attributions")
      .select(["id", "role", "madeRoleId"])
      .where("userId", "=", input.userId)
      .where("scope", "=", "base")
      .where("scopeId", "=", input.baseId)
      .executeTakeFirst();
    if (!own) throw new AppError("no_base_role");
    if (
      own.role === "owner" &&
      owners.includes(input.userId) &&
      owners.length < 2
    ) {
      throw new AppError("invalid_owner");
    }
    const tables = await tx
      .selectFrom("dataTables as t")
      .select("t.id")
      .where("t.baseId", "=", input.baseId)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("attributions as a")
              .select("a.id")
              .whereRef("a.scopeId", "=", "t.id")
              .where("a.scope", "=", "table")
              .where("a.userId", "=", input.userId),
          ),
        ),
      )
      .execute();
    if (tables.length > 0) {
      await tx
        .insertInto("attributions")
        .values(
          tables.map((table) => ({
            userId: input.userId,
            role: own.role,
            madeRoleId: own.madeRoleId,
            scope: "table" as const,
            scopeId: table.id,
            givenBy: actorId,
          })),
        )
        .execute();
    }
    await tx.deleteFrom("attributions").where("id", "=", own.id).execute();
  });
}

/**
 * The base's members and their role. A role a group gives names the
 * group; `direct` says whether the person has one of their own, the one
 * this list can change or remove. Someone with roles on some of its tables
 * and none on the base is a member too, `tablesOnly` (ADR 0131).
 */
export async function listMembers(db: Database, baseId: string) {
  const rows = await db
    .selectFrom("attributions as a")
    .leftJoin("groupMembers as gm", "gm.groupId", "a.groupId")
    .innerJoin("users as u", (join) =>
      join.on(sql<boolean>`u.id = coalesce(a.user_id, gm.user_id)`),
    )
    .leftJoin("groups as g", "g.id", "a.groupId")
    .leftJoin("madeRoles as m", "m.id", "a.madeRoleId")
    .select([
      "u.id as userId",
      "u.displayName",
      "u.email",
      "a.role",
      "a.scope",
      "a.scopeId",
      "g.displayName as groupName",
      ...MADE_COLUMNS,
    ])
    .where((eb) =>
      eb.or([
        eb.and([eb("a.scope", "=", "base"), eb("a.scopeId", "=", baseId)]),
        eb.and([
          eb("a.scope", "=", "table"),
          eb("a.userId", "is not", null),
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
    .orderBy("u.displayName")
    .execute();
  const grouped = new Map<
    string,
    {
      userId: string;
      displayName: string;
      email: string;
      bindings: Binding[];
      /** The role of their own, which the list changes: a key or an id. */
      given: string | null;
      groups: string[];
    }
  >();
  for (const row of rows) {
    const current = grouped.get(row.userId) ?? {
      userId: row.userId,
      displayName: row.displayName,
      email: row.email,
      bindings: [],
      given: null,
      groups: [],
    };
    const own = givenOf(row);
    grouped.set(row.userId, {
      ...current,
      bindings: [...current.bindings, ...bindingsFrom([row])],
      given:
        row.scope === "base" && row.groupName === null && own !== null
          ? typeof own === "string"
            ? own
            : own.id
          : current.given,
      groups:
        row.groupName === null
          ? current.groups
          : [...current.groups, row.groupName],
    });
  }
  return [...grouped.values()].map(({ bindings, given, ...member }) => {
    const role = roleFor(bindings, "base", baseId);
    return {
      ...member,
      role,
      given,
      direct: given !== null || role === null,
      tablesOnly: role === null,
    };
  });
}

/**
 * Whether the address holds a role of its own on the base or on one of its
 * tables: such a person is in the list of members, which whoever manages
 * the base reads.
 */
export async function isMember(
  db: Database,
  baseId: string,
  email: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("attributions as a")
    .innerJoin("users as u", "u.id", "a.userId")
    .select("a.id")
    .where("u.email", "=", email.toLowerCase())
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
    .executeTakeFirst();
  return row !== undefined;
}

export async function grantMember(
  db: Database,
  actorId: string,
  input: { baseId: string; email: string; role: Given },
): Promise<void> {
  const email = input.email.toLowerCase();
  const user = await db
    .selectFrom("users")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirst();
  if (!user) {
    throw new AppError("unknown_account");
  }
  await setMemberRole(db, actorId, {
    baseId: input.baseId,
    userId: user.id,
    role: input.role,
  });
}

export async function revokeMember(
  db: Database,
  actorId: string,
  input: { baseId: string; userId: string },
): Promise<void> {
  const tablesOfBase = await tableIds(db, input.baseId);
  const ids = [input.baseId, ...tablesOfBase];
  await withAudit(db, { userId: actorId }, async (tx) => {
    // A base keeps an owner: its last one cannot leave it.
    const owners = await lockedOwners(tx, input.baseId);
    if (owners.includes(input.userId) && owners.length < 2) {
      throw new AppError("invalid_owner");
    }
    // Their roles on the base and its tables go, with the rules they carry.
    await tx
      .deleteFrom("attributions")
      .where("userId", "=", input.userId)
      .where("scopeId", "in", ids)
      .execute();
  });
}
