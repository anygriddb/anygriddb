/**
 * Groups and the roles bases give them (ADR 0038). A member's access comes
 * as a role binding of the group's: every check that reads bindings sees
 * it, and it follows the group's members and roles here, in the same
 * transaction.
 */
import { AppError, type Role } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { type AuditTx, withAudit } from "../data/audit-context.js";
import { liveBase } from "../data/live.js";

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
      "g.externalId",
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
): Promise<void> {
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
  await withAudit(db, { userId: actorId, source: "web" }, async (tx) => {
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
  });
}
