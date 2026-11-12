import { AppError, type Role, roleFor } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { withAudit, type AuditTx } from "./audit-context.js";
import { liveBase } from "./live.js";

export const grantInputSchema = z.object({
  baseId: z.uuid(),
  email: z.email().max(254),
  role: z.enum(["owner", "editor", "commenter", "viewer"]),
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

async function ownerIds(db: Database, baseId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("roleBindings")
    .select("userId")
    .where("scope", "=", "base")
    .where("scopeId", "=", baseId)
    .where("role", "=", "owner")
    .execute();
  return [...new Set(rows.map((row) => row.userId))];
}

/**
 * Sets the base role. Table overrides for that user are cleared, so the
 * base role applies to every table again.
 */
/** Live bases this account alone owns. */
export async function soleOwnerBases(
  db: Database,
  userId: string,
): Promise<{ id: string; name: string }[]> {
  return db
    .selectFrom("bases as b")
    .innerJoin("roleBindings as own", (join) =>
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
            .selectFrom("roleBindings as other")
            .select("other.userId")
            .whereRef("other.scopeId", "=", "b.id")
            .where("other.scope", "=", "base")
            .where("other.role", "=", "owner")
            .where("other.userId", "<>", userId),
        ),
      ),
    )
    .orderBy("b.name", "asc")
    .execute();
}

/**
 * Gives an account one role on a base, in the caller's audited
 * transaction: the bindings it had on the base and its tables give way.
 */
export async function bindRole(
  tx: AuditTx,
  userId: string,
  role: Role,
  baseId: string,
): Promise<void> {
  const ids = [baseId, ...(await tableIds(tx, baseId))];
  // A group's bindings follow the group, not this choice.
  await tx
    .deleteFrom("roleBindings")
    .where("userId", "=", userId)
    .where("scopeId", "in", ids)
    .where("groupId", "is", null)
    .execute();
  await tx
    .insertInto("roleBindings")
    .values({ userId, role, scope: "base", scopeId: baseId })
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
 * one cannot be given another role.
 */
export async function setMemberRole(
  db: Database,
  actorId: string,
  input: { baseId: string; userId: string; role: Role },
): Promise<void> {
  await withAudit(db, { userId: actorId, source: "web" }, async (tx) => {
    const owners = await lockedOwners(tx, input.baseId);
    if (
      input.role !== "owner" &&
      owners.includes(input.userId) &&
      owners.length < 2
    ) {
      throw new AppError("invalid_owner");
    }
    await bindRole(tx, input.userId, input.role, input.baseId);
  });
}

/**
 * The base's members and their role. A role a group gives names the
 * group; `direct` says whether the person has one of their own, the one
 * this list can change or remove.
 */
export async function listMembers(db: Database, baseId: string) {
  const rows = await db
    .selectFrom("roleBindings as b")
    .innerJoin("users as u", "u.id", "b.userId")
    .leftJoin("groups as g", "g.id", "b.groupId")
    .select([
      "u.id as userId",
      "u.displayName",
      "u.email",
      "b.role",
      "g.displayName as groupName",
    ])
    .where("b.scope", "=", "base")
    .where("b.scopeId", "=", baseId)
    .orderBy("u.displayName")
    .execute();
  const grouped = new Map<
    string,
    {
      userId: string;
      displayName: string;
      email: string;
      role: Role;
      direct: boolean;
      groups: string[];
    }
  >();
  for (const row of rows) {
    const current = grouped.get(row.userId) ?? {
      userId: row.userId,
      displayName: row.displayName,
      email: row.email,
      role: row.role,
      direct: false,
      groups: [],
    };
    const role = roleFor(
      [
        { role: current.role, scope: "base", scopeId: baseId },
        { role: row.role, scope: "base", scopeId: baseId },
      ],
      "base",
      baseId,
    );
    grouped.set(row.userId, {
      ...current,
      role: role ?? current.role,
      direct: current.direct || row.groupName === null,
      groups:
        row.groupName === null
          ? current.groups
          : [...current.groups, row.groupName],
    });
  }
  return [...grouped.values()];
}

/**
 * Whether the address holds a role of its own on the base: such a person
 * is in the list of members, which whoever manages the base reads.
 */
export async function isMember(
  db: Database,
  baseId: string,
  email: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("roleBindings as b")
    .innerJoin("users as u", "u.id", "b.userId")
    .select("b.id")
    .where("u.email", "=", email.toLowerCase())
    .where("b.scope", "=", "base")
    .where("b.scopeId", "=", baseId)
    .where("b.groupId", "is", null)
    .executeTakeFirst();
  return row !== undefined;
}

export async function grantMember(
  db: Database,
  actorId: string,
  input: { baseId: string; email: string; role: Role },
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
    for (const scopeId of ids) {
      await tx
        .deleteFrom("roleBindings")
        .where("userId", "=", input.userId)
        .where("scopeId", "=", scopeId)
        .where("groupId", "is", null)
        .execute();
    }
    // Rules for someone who left the base mean nothing; they go too.
    if (tablesOfBase.length > 0) {
      for (const acl of ["columnAcls", "tableAcls"] as const) {
        await tx
          .deleteFrom(acl)
          .where("userId", "=", input.userId)
          .where("tableId", "in", tablesOfBase)
          .execute();
      }
    }
  });
}
