/**
 * Groups and the roles bases give them (ADR 0038, ADR 0070). A member's
 * access comes as a role binding of the group's: every check that reads
 * bindings sees it, and it follows the group's members and roles here, in
 * the same transaction. A null provider is a local group Administration
 * keeps; `scim` means an identity provider owns the membership.
 */
import { AppError, labelSchema, type Role } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { z } from "zod";
import { type AuditTx, withAudit } from "../data/audit-context.js";
import { ERASED_USER_ID } from "../data/erasure.js";
import { liveBase } from "../data/live.js";
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

/**
 * Brings the group's bindings in line with its roles and members: adds
 * the missing ones, removes the others, and leaves the rest, so the audit
 * trail shows only what changed.
 */
export async function syncGroupBindings(
  tx: AuditTx,
  groupId: string,
): Promise<void> {
  await sql`
    delete from role_bindings b
    where b.group_id = ${groupId}
      and not exists (
        select 1
        from group_roles r
        join group_members m on m.group_id = r.group_id
        where r.group_id = b.group_id
          and m.user_id = b.user_id
          and b.scope = 'base'
          and r.base_id = b.scope_id
          and r.role = b.role
      )
  `.execute(tx);
  await sql`
    insert into role_bindings (user_id, role, scope, scope_id, group_id)
    select m.user_id, r.role, 'base', r.base_id, r.group_id
    from group_roles r
    join group_members m on m.group_id = r.group_id
    where r.group_id = ${groupId}
      and not exists (
        select 1 from role_bindings b
        where b.group_id = r.group_id
          and b.user_id = m.user_id
          and b.scope = 'base'
          and b.scope_id = r.base_id
          and b.role = r.role
      )
  `.execute(tx);
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
      sql<number>`(select count(*)::int from group_roles r where r.group_id = g.id)`.as(
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
      .selectFrom("groupRoles as r")
      .innerJoin("bases as b", "b.id", "r.baseId")
      .select(["r.baseId", "b.name as baseName", "r.role"])
      .where("r.groupId", "=", groupId)
      .where(liveBase("b"))
      .orderBy(sql`lower(b.name)`)
      .execute(),
  ]);
  return { ...group, members, roles };
}

/** The groups a base gives a role to, with their member counts. */
export async function listGroupRoles(db: Database, baseId: string) {
  return db
    .selectFrom("groupRoles as r")
    .innerJoin("groups as g", "g.id", "r.groupId")
    .select([
      "r.groupId",
      "g.displayName",
      "r.role",
      sql<number>`(select count(*)::int from group_members m where m.group_id = g.id)`.as(
        "members",
      ),
    ])
    .where("r.baseId", "=", baseId)
    .orderBy(sql`lower(g.display_name)`)
    .execute();
}

/**
 * Gives a group a role on a base, changes it, or takes it back (`null`):
 * its members' bindings follow at once.
 */
export async function setGroupRole(
  db: Database,
  actorId: string,
  input: { baseId: string; groupId: string; role: Role | null },
): Promise<{ previous: Role | null }> {
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
    const before = await tx
      .selectFrom("groupRoles")
      .select("role")
      .where("groupId", "=", input.groupId)
      .where("baseId", "=", input.baseId)
      .executeTakeFirst();
    if (input.role) {
      await tx
        .insertInto("groupRoles")
        .values({
          groupId: input.groupId,
          baseId: input.baseId,
          role: input.role,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["groupId", "baseId"])
            .doUpdateSet({ role: input.role ?? "viewer" }),
        )
        .execute();
    } else {
      await tx
        .deleteFrom("groupRoles")
        .where("groupId", "=", input.groupId)
        .where("baseId", "=", input.baseId)
        .execute();
    }
    await syncGroupBindings(tx, input.groupId);
    return { previous: before?.role ?? null };
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
    await tx.deleteFrom("groups").where("id", "=", groupId).execute();
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
): Promise<{ roles: { baseId: string; role: Role }[] }> {
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
    await syncGroupBindings(tx, input.groupId);
    // The roles the group holds, which the new member now has; none for
    // someone who was a member already.
    if (!added) return { roles: [] };
    return {
      roles: await tx
        .selectFrom("groupRoles")
        .select(["baseId", "role"])
        .where("groupId", "=", input.groupId)
        .execute(),
    };
  });
}

/** Removes a member from a local group; bindings follow at once. */
export async function removeLocalGroupMember(
  db: Database,
  actorId: string,
  input: { groupId: string; userId: string },
): Promise<void> {
  await withAudit(db, { userId: actorId, source: "web" }, async (tx) => {
    await requireLocalGroup(tx, input.groupId);
    await tx
      .deleteFrom("groupMembers")
      .where("groupId", "=", input.groupId)
      .where("userId", "=", input.userId)
      .execute();
    await syncGroupBindings(tx, input.groupId);
  });
}
