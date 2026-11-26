/**
 * Administration's five roles (administrator, support, auditor, account
 * manager, source manager), each an attribution at the instance given to a
 * person (ADR 0131, §4). Every read of what an account is in
 * Administration, and every change of it, goes through here.
 */
import {
  INSTANCE_ROLES,
  type InstanceCaller,
  type InstanceRole,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import type { InstanceFlags } from "../access/declaration.js";
import type { AuditTx } from "../data/audit-context.js";

const KNOWN = new Set<string>(INSTANCE_ROLES);

/** The roles a row says, those this version knows. */
export function knownInstanceRoles(
  raw: readonly string[] | null | undefined,
): InstanceRole[] {
  return (raw ?? []).filter((role): role is InstanceRole => KNOWN.has(role));
}

/**
 * Whether the account `userRef` names holds this role of Administration,
 * as an expression of a select or a condition.
 */
function holdsInstance(userRef: string, role: InstanceCaller) {
  return sql<boolean>`exists (select 1 from attributions ia where ia.user_id = ${sql.ref(userRef)} and ia.scope = 'instance' and ia.instance_role = ${role})`;
}

/** An administrator, by the account `userRef` names. */
export function isAdminOf(userRef: string) {
  return holdsInstance(userRef, "administrator");
}

/** Support, by the account `userRef` names. */
export function isSupportOf(userRef: string) {
  return holdsInstance(userRef, "support");
}

/** An auditor, by the account `userRef` names. */
export function isAuditorOf(userRef: string) {
  return holdsInstance(userRef, "auditor");
}

/**
 * The roles given beside administration, support and the auditor (an
 * account manager, a source manager), as one column of a select.
 */
export function instanceRolesOf(userRef: string) {
  return sql<
    string[]
  >`coalesce((select array_agg(ia.instance_role order by ia.instance_role) from attributions ia where ia.user_id = ${sql.ref(userRef)} and ia.scope = 'instance' and ia.instance_role in ('account_manager', 'source_manager')), '{}')`;
}

/** Whether the account `userRef` names holds any role of Administration. */
export function holdsAnyInstanceRole(userRef: string) {
  return sql<boolean>`exists (select 1 from attributions ia where ia.user_id = ${sql.ref(userRef)} and ia.scope = 'instance')`;
}

/** Whether it holds one of the roles given beside the three first. */
export function holdsInstanceRole(userRef: string) {
  return sql<boolean>`exists (select 1 from attributions ia where ia.user_id = ${sql.ref(userRef)} and ia.scope = 'instance' and ia.instance_role in ('account_manager', 'source_manager'))`;
}

/** Each account's roles of Administration, as `InstanceFlags` read. */
function instanceColumns(userRef: string) {
  return [
    isAdminOf(userRef).as("isAdmin"),
    isSupportOf(userRef).as("isSupport"),
    isAuditorOf(userRef).as("isAuditor"),
    instanceRolesOf(userRef).as("instanceRoles"),
  ] as const;
}

/**
 * Gives a role of Administration or takes it away, in the caller's
 * audited transaction: the change trail names who did it.
 */
export async function setInstanceAttribution(
  tx: AuditTx,
  input: {
    userId: string;
    role: InstanceCaller;
    held: boolean;
    givenBy?: string | null;
  },
): Promise<void> {
  if (input.held) {
    await tx
      .insertInto("attributions")
      .values({
        userId: input.userId,
        scope: "instance",
        scopeId: null,
        instanceRole: input.role,
        givenBy: input.givenBy ?? null,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["userId", "instanceRole"])
          .where("instanceRole", "is not", null)
          .doNothing(),
      )
      .execute();
    return;
  }
  await tx
    .deleteFrom("attributions")
    .where("userId", "=", input.userId)
    .where("scope", "=", "instance")
    .where("instanceRole", "=", input.role)
    .execute();
}

/**
 * A role of Administration nobody's hand gives: the first account, the
 * operator's command, the environment. Written in the account's own name,
 * from `source`, in the caller's transaction.
 */
export async function giveOwnInstanceRole(
  tx: AuditTx,
  input: { userId: string; role: InstanceCaller; source: string },
): Promise<void> {
  await sql`
    select set_config('anygrid.user_id', ${input.userId}, true),
      set_config('anygrid.source', ${input.source}, true)
  `.execute(tx);
  await setInstanceAttribution(tx, {
    userId: input.userId,
    role: input.role,
    held: true,
  });
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
    .select(["disabledAt", ...instanceColumns("users.id")])
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
