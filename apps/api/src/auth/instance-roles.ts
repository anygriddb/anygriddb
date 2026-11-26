/**
 * Roles of Administration given beside administration, support and the
 * auditor (ROADMAP #34, ADR 0126): rows of `instance_roles`.
 */
import { INSTANCE_ROLES, type InstanceRole } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import type { InstanceFlags } from "../access/declaration.js";

const KNOWN = new Set<string>(INSTANCE_ROLES);

/** The roles a row says, those this version knows. */
export function knownInstanceRoles(
  raw: readonly string[] | null | undefined,
): InstanceRole[] {
  return (raw ?? []).filter((role): role is InstanceRole => KNOWN.has(role));
}

/** The roles of the account `userId` names, as one column of a select. */
export function instanceRolesOf(userId: string) {
  return sql<
    string[]
  >`coalesce((select array_agg(r.role order by r.role) from instance_roles r where r.user_id = ${sql.ref(userId)}), '{}')`;
}

/** Whether the account `userId` names holds one of these roles. */
export function holdsInstanceRole(userId: string) {
  return sql<boolean>`exists (select 1 from instance_roles r where r.user_id = ${sql.ref(userId)})`;
}

/**
 * What an account is in Administration, read from the database: for work
 * done in its name without its session (a job).
 */
export async function loadInstanceFlags(
  db: Database,
  userId: string,
): Promise<InstanceFlags & { disabledAt: Date | null }> {
  const row = await db
    .selectFrom("users")
    .select([
      "isAdmin",
      "isSupport",
      "isAuditor",
      "disabledAt",
      instanceRolesOf("users.id").as("instanceRoles"),
    ])
    .where("id", "=", userId)
    .executeTakeFirst();
  return row
    ? { ...row, instanceRoles: knownInstanceRoles(row.instanceRoles) }
    : {
        isAdmin: false,
        isSupport: false,
        isAuditor: false,
        instanceRoles: [],
        disabledAt: null,
      };
}
