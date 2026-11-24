/**
 * Roles of Administration given beside administration, support and the
 * auditor (ROADMAP #34, ADR 0126): rows of `instance_roles`.
 */
import { INSTANCE_ROLES, type InstanceRole } from "@anygriddb/core";
import { sql } from "kysely";

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
