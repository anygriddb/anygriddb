/**
 * Groups and the roles bases give them (ADR 0038, ADR 0070). A member's
 * access comes as a role binding of the group's: every check that reads
 * bindings sees it, and it follows the group's members and roles here, in
 * the same transaction. A null provider is a local group Administration
 * keeps; `scim` means an identity provider owns the membership.
 */
import { AppError, type Given, labelSchema } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { z } from "zod";
import { type AuditTx, withAudit } from "../data/audit-context.js";
import { ERASED_USER_ID } from "../data/erasure.js";
import { liveAttribution } from "../data/attributions.js";
import { liveBase } from "../data/live.js";
import { givenColumns, givenOf, MADE_COLUMNS } from "../data/made-roles.js";
import { postgresCode } from "../data/pg-error.js";

const descriptionSchema = z.string().trim().max(500).nullable().optional();

function descriptionOf(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.length === 0) return null;
  return value;
}

export const createLocalGroupInputSchema = z
  .object({
    displayName: labelSchema,
    description: descriptionSchema,
  })
  .strict()
  .transform((input) => ({
    ...input,
    description: descriptionOf(input.description),
  }));

export const updateLocalGroupInputSchema = z
  .object({
    groupId: z.uuid(),
    displayName: labelSchema,
    description: descriptionSchema,
  })
  .strict()
  .transform((input) => ({
    ...input,
    description: descriptionOf(input.description),
  }));

export const localGroupMemberInputSchema = z
  .object({
    groupId: z.uuid(),
    userId: z.uuid(),
  })
  .strict();

type CreateLocalGroupInput = z.infer<typeof createLocalGroupInputSchema>;
type UpdateLocalGroupInput = z.infer<typeof updateLocalGroupInputSchema>;

/** True when Administration owns the group's membership. */
export function isLocalGroup(provider: string | null): boolean {
  return provider === null;
}

/** Which of these bases have an owner, by any role of theirs or a group's. */
async function basesWithOwner(
  tx: AuditTx,
  baseIds: readonly string[],
): Promise<Set<string>> {
  if (baseIds.length === 0) return new Set();
  const rows = await tx
    .selectFrom("attributions as a")
    .leftJoin("groupMembers as gm", "gm.groupId", "a.groupId")
    .select("a.scopeId")
    .distinct()
    .where("a.scope", "=", "base")
    .where("a.scopeId", "in", baseIds)
    .where("a.role", "=", "owner")
    .where((eb) =>
      eb.or([eb("a.userId", "is not", null), eb("gm.userId", "is not", null)]),
    )
    .where(liveAttribution)
    .execute();
  return new Set(
    rows.flatMap((row) => (row.scopeId === null ? [] : [row.scopeId])),
  );
}

/**
 * The bases a group owns that have an owner now, their rows held until
 * the transaction ends, as a change to a base's members holds it: a change
 * to the group waits for any change to those bases' members, and sees it.
 */
async function ownedThroughGroup(
  tx: AuditTx,
  groupId: string,
): Promise<string[]> {
  const bases = await tx
    .selectFrom("bases as b")
    .innerJoin("attributions as r", "r.scopeId", "b.id")
    .select("b.id")
    .where("r.groupId", "=", groupId)
    .where("r.scope", "=", "base")
    .where("r.role", "=", "owner")
    .where(liveBase("b"))
    .orderBy("b.id")
    .forUpdate("b")
    .execute();
  return [
    ...(await basesWithOwner(
      tx,
      bases.map((base) => base.id),
    )),
  ];
}

/**
 * Refuses a change to a group that left one of these bases, which had an
 * owner, with none: nobody could then share it, change its structure or
 * delete it. A person keeps their base by a role of their own, or another
 * group's.
 */
async function assertOwnersLeft(
  tx: AuditTx,
  baseIds: readonly string[],
): Promise<void> {
  const owned = await basesWithOwner(tx, baseIds);
  if (baseIds.some((id) => !owned.has(id))) {
    throw new AppError("invalid_owner");
  }
}

/** The instance's groups, for administrators and for sharing a base. */
export async function listGroups(db: Database) {
  const rows = await db
    .selectFrom("groups as g")
    .select([
      "g.id",
      "g.displayName",
      "g.description",
      "g.externalId",
      "g.provider",
      sql<number>`(select count(*)::int from group_members m where m.group_id = g.id)`.as(
        "members",
      ),
      sql<number>`(select count(*)::int from attributions r where r.group_id = g.id and r.scope = 'base')`.as(
        "bases",
      ),
    ])
    .orderBy(sql`lower(g.display_name)`)
    .limit(1_000)
    .execute();
  return rows;
}

/** One group with its members and the bases it has a role on. */
export async function getGroup(db: Database, groupId: string) {
  const group = await db
    .selectFrom("groups")
    .select([
      "id",
      "displayName",
      "description",
      "externalId",
      "provider",
      "createdAt",
      "updatedAt",
    ])
    .where("id", "=", groupId)
    .executeTakeFirst();
  if (!group) throw new AppError("unknown_group");
  const [members, roles] = await Promise.all([
    db
      .selectFrom("groupMembers as m")
      .innerJoin("users as u", "u.id", "m.userId")
      .select(["u.id as userId", "u.displayName", "u.email"])
      .where("m.groupId", "=", groupId)
      .where("u.id", "<>", ERASED_USER_ID)
      .orderBy(sql`lower(u.display_name)`)
      .execute(),
    db
      .selectFrom("attributions as r")
      .innerJoin("bases as b", "b.id", "r.scopeId")
      .leftJoin("madeRoles as made", "made.id", "r.madeRoleId")
      .select([
        "b.id as baseId",
        "b.name as baseName",
        "r.role",
        "made.id as madeId",
        "made.name as madeName",
        "made.permissions as madePermissions",
      ])
      .where("r.groupId", "=", groupId)
      .where("r.scope", "=", "base")
      .where(liveBase("b"))
      .orderBy(sql`lower(b.name)`)
      .execute(),
  ]);
  return {
    ...group,
    members,
    roles: roles.map((row) => ({
      baseId: row.baseId,
      baseName: row.baseName,
      role: givenOf(row),
    })),
  };
}

/** The groups a base gives a role to, with their member counts. */
export async function listGroupRoles(db: Database, baseId: string) {
  const rows = await db
    .selectFrom("attributions as r")
    .innerJoin("groups as g", "g.id", "r.groupId")
    .leftJoin("madeRoles as m", "m.id", "r.madeRoleId")
    .select([
      "g.id as groupId",
      "g.displayName",
      "r.role",
      ...MADE_COLUMNS,
      sql<number>`(select count(*)::int from group_members gm where gm.group_id = g.id)`.as(
        "members",
      ),
    ])
    .where("r.scope", "=", "base")
    .where("r.scopeId", "=", baseId)
    .orderBy(sql`lower(g.display_name)`)
    .execute();
  return rows.map((row) => ({
    groupId: row.groupId,
    displayName: row.displayName,
    members: row.members,
    role: givenOf(row),
  }));
}

/**
 * Gives a group a role on a base, changes it, or takes it back (`null`):
 * one attribution, which reaches its members as they are (ADR 0131).
 */
export async function setGroupRole(
  db: Database,
  actorId: string,
  input: { baseId: string; groupId: string; role: Given | null },
): Promise<{ previous: Given | null }> {
  const base = await db
    .selectFrom("bases")
    .select("id")
    .where("id", "=", input.baseId)
    .where(liveBase())
    .executeTakeFirst();
  const group = await db
    .selectFrom("groups")
    .select("id")
    .where("id", "=", input.groupId)
    .executeTakeFirst();
  if (!base || !group)
    throw new AppError(base ? "unknown_group" : "unknown_base");
  return withAudit(db, { userId: actorId, source: "web" }, async (tx) => {
    const owned = await ownedThroughGroup(tx, input.groupId);
    const before = await tx
      .selectFrom("attributions as r")
      .leftJoin("madeRoles as m", "m.id", "r.madeRoleId")
      .select(["r.id", "r.role", ...MADE_COLUMNS])
      .where("r.groupId", "=", input.groupId)
      .where("r.scope", "=", "base")
      .where("r.scopeId", "=", input.baseId)
      .executeTakeFirst();
    if (input.role) {
      const given = givenColumns(input.role);
      if (before) {
        await tx
          .updateTable("attributions")
          .set({ ...given, givenBy: actorId })
          .where("id", "=", before.id)
          .execute();
      } else {
        await tx
          .insertInto("attributions")
          .values({
            groupId: input.groupId,
            scope: "base",
            scopeId: input.baseId,
            givenBy: actorId,
            ...given,
          })
          .execute();
      }
    } else if (before) {
      await tx.deleteFrom("attributions").where("id", "=", before.id).execute();
    }
    await assertOwnersLeft(tx, owned);
    return { previous: before ? givenOf(before) : null };
  });
}

async function requireLocalGroup(
  tx: AuditTx | Database,
  groupId: string,
): Promise<{ id: string }> {
  const group = await tx
    .selectFrom("groups")
    .select(["id", "provider"])
    .where("id", "=", groupId)
    .executeTakeFirst();
  if (!group) throw new AppError("unknown_group");
  if (!isLocalGroup(group.provider)) throw new AppError("group_provisioned");
  return { id: group.id };
}

function rethrowNameTaken(error: unknown): never {
  if (postgresCode(error) === "23505") {
    throw new AppError("group_already_exists");
  }
  throw error;
}

/** Makes a local group; membership starts empty. */
export async function createLocalGroup(
  db: Database,
  actorId: string,
  input: CreateLocalGroupInput,
): Promise<{ id: string }> {
  try {
    return await withAudit(
      db,
      { userId: actorId, source: "web" },
      async (tx) => {
        const created = await tx
          .insertInto("groups")
          .values({
            displayName: input.displayName,
            description: input.description ?? null,
            provider: null,
            externalId: null,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        return { id: created.id };
      },
    );
  } catch (error) {
    rethrowNameTaken(error);
  }
}

/** Renames or describes a local group. */
export async function updateLocalGroup(
  db: Database,
  actorId: string,
  input: UpdateLocalGroupInput,
): Promise<void> {
  try {
    await withAudit(db, { userId: actorId, source: "web" }, async (tx) => {
      await requireLocalGroup(tx, input.groupId);
      await tx
        .updateTable("groups")
        .set({
          displayName: input.displayName,
          description: input.description ?? null,
          updatedAt: new Date(),
        })
        .where("id", "=", input.groupId)
        .execute();
    });
  } catch (error) {
    rethrowNameTaken(error);
  }
}

/** Deletes a local group; its roles and bindings go with it. */
export async function deleteLocalGroup(
  db: Database,
  actorId: string,
  groupId: string,
): Promise<void> {
  await withAudit(db, { userId: actorId, source: "web" }, async (tx) => {
    await requireLocalGroup(tx, groupId);
    const owned = await ownedThroughGroup(tx, groupId);
    await tx.deleteFrom("groups").where("id", "=", groupId).execute();
    await assertOwnersLeft(tx, owned);
  });
}

async function requireActiveAccount(
  tx: AuditTx,
  userId: string,
): Promise<void> {
  const account = await tx
    .selectFrom("users")
    .select("id")
    .where("id", "=", userId)
    .where("id", "<>", ERASED_USER_ID)
    .where("deprovisionedAt", "is", null)
    .where("disabledAt", "is", null)
    .executeTakeFirst();
  if (!account) throw new AppError("unknown_account");
}

/** Adds an active account to a local group; bindings follow at once. */
export async function addLocalGroupMember(
  db: Database,
  actorId: string,
  input: { groupId: string; userId: string },
): Promise<{ roles: { baseId: string; role: Given }[] }> {
  return withAudit(db, { userId: actorId, source: "web" }, async (tx) => {
    await requireLocalGroup(tx, input.groupId);
    await requireActiveAccount(tx, input.userId);
    const added = await tx
      .insertInto("groupMembers")
      .values({ groupId: input.groupId, userId: input.userId })
      .onConflict((conflict) =>
        conflict.columns(["groupId", "userId"]).doNothing(),
      )
      .returning("userId")
      .executeTakeFirst();
    // The roles the group holds, which the new member now has; none for
    // someone who was a member already.
    if (!added) return { roles: [] };
    const roles = await tx
      .selectFrom("attributions as r")
      .leftJoin("madeRoles as m", "m.id", "r.madeRoleId")
      .select(["r.scopeId as baseId", "r.role", ...MADE_COLUMNS])
      .where("r.groupId", "=", input.groupId)
      .where("r.scope", "=", "base")
      .execute();
    return {
      roles: roles.flatMap((row) => {
        const role = givenOf(row);
        return role && row.baseId ? [{ baseId: row.baseId, role }] : [];
      }),
    };
  });
}

/** Removes a member from a local group: its roles stop reaching them. */
export async function removeLocalGroupMember(
  db: Database,
  actorId: string,
  input: { groupId: string; userId: string },
): Promise<void> {
  await withAudit(db, { userId: actorId, source: "web" }, async (tx) => {
    await requireLocalGroup(tx, input.groupId);
    const owned = await ownedThroughGroup(tx, input.groupId);
    await tx
      .deleteFrom("groupMembers")
      .where("groupId", "=", input.groupId)
      .where("userId", "=", input.userId)
      .execute();
    await assertOwnersLeft(tx, owned);
  });
}
