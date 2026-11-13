/**
 * What SCIM requests do to accounts and groups (ADR 0038). Every change
 * runs as the token's administrator, audited with the source `scim`.
 */
import {
  parseScimGroup,
  parseScimUser,
  patchScimGroup,
  patchScimUser,
  ScimError,
  type ScimFilter,
  type ScimGroupState,
  scimGroupResource,
  type ScimPatchOperation,
  scimUserResource,
  type ScimUserState,
} from "@anygriddb/core";
import type { Database, UserRow } from "@anygriddb/db";
import { type Expression, type SqlBool, sql } from "kysely";
import { type AuditTx, withAudit } from "../data/audit-context.js";
import { ERASED_USER_ID } from "../data/erasure.js";
import { postgresCode } from "../data/pg-error.js";
import { syncGroupBindings } from "./groups.js";

export type ScimContext = { db: Database; actorId: string; baseUrl: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new ScimError(404, "Resource not found");
const taken = (what: string) =>
  new ScimError(409, `${what} is already used`, "uniqueness");

/** Runs a change as the token's administrator; a duplicate is a 409. */
async function change<T>(
  context: ScimContext,
  fn: (tx: AuditTx) => Promise<T>,
): Promise<T> {
  try {
    return await withAudit(
      context.db,
      { userId: context.actorId, source: "scim" },
      fn,
    );
  } catch (error) {
    if (postgresCode(error) === "23505") throw taken("A unique value");
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

type Account = Pick<
  UserRow,
  | "id"
  | "email"
  | "displayName"
  | "isAdmin"
  | "disabledAt"
  | "createdAt"
  | "scimExternalId"
  | "scimUserName"
  | "deprovisionedAt"
>;

const ACCOUNT_COLUMNS = [
  "id",
  "email",
  "displayName",
  "isAdmin",
  "disabledAt",
  "createdAt",
  "scimExternalId",
  "scimUserName",
  "deprovisionedAt",
] as const;

function stateOf(account: Account): ScimUserState {
  return {
    userName: account.scimUserName ?? account.email,
    email: account.email,
    displayName: account.displayName,
    externalId: account.scimExternalId,
    active: account.disabledAt === null,
  };
}

async function groupsOf(db: Database, userIds: readonly string[]) {
  if (userIds.length === 0)
    return new Map<string, Array<{ id: string; displayName: string }>>();
  const rows = await db
    .selectFrom("groupMembers as m")
    .innerJoin("groups as g", "g.id", "m.groupId")
    .select(["m.userId", "g.id", "g.displayName"])
    .where("m.userId", "in", [...userIds])
    .execute();
  const byUser = new Map<string, Array<{ id: string; displayName: string }>>();
  for (const row of rows) {
    const list = byUser.get(row.userId) ?? [];
    list.push({ id: row.id, displayName: row.displayName });
    byUser.set(row.userId, list);
  }
  return byUser;
}

async function userResources(
  context: ScimContext,
  accounts: readonly Account[],
) {
  const groups = await groupsOf(
    context.db,
    accounts.map((account) => account.id),
  );
  return accounts.map((account) =>
    scimUserResource(
      {
        ...stateOf(account),
        id: account.id,
        created: account.createdAt,
        groups: groups.get(account.id) ?? [],
      },
      context.baseUrl,
    ),
  );
}

/** An account the provider can see: not one it removed. */
async function findAccount(
  db: Database | AuditTx,
  id: string,
  lock = false,
): Promise<Account> {
  if (!UUID.test(id)) throw notFound();
  let query = db
    .selectFrom("users")
    .select(ACCOUNT_COLUMNS)
    .where("id", "=", id)
    .where("id", "<>", ERASED_USER_ID)
    .where("deprovisionedAt", "is", null);
  if (lock) query = query.forUpdate();
  const account = await query.executeTakeFirst();
  if (!account) throw notFound();
  return account;
}

function userCondition(filter: ScimFilter | null): Expression<SqlBool> {
  if (!filter) return sql<SqlBool>`true`;
  const value = filter.value;
  switch (filter.attribute) {
    case "id":
      return UUID.test(value)
        ? sql<SqlBool>`id = ${value}::uuid`
        : sql<SqlBool>`false`;
    case "userName":
      return sql<SqlBool>`lower(coalesce(scim_user_name, email)) = lower(${value})`;
    case "externalId":
      return sql<SqlBool>`scim_external_id = ${value}`;
    case "email":
      return sql<SqlBool>`email = lower(${value})`;
    default:
      return sql<SqlBool>`lower(display_name) = lower(${value})`;
  }
}

export async function listScimUsers(
  context: ScimContext,
  filter: ScimFilter | null,
  page: { offset: number; limit: number },
) {
  const where = userCondition(filter);
  const total = await context.db
    .selectFrom("users")
    .select(sql<number>`count(*)::int`.as("value"))
    .where("deprovisionedAt", "is", null)
    .where("id", "<>", ERASED_USER_ID)
    .where(where)
    .executeTakeFirstOrThrow();
  const accounts =
    page.limit === 0
      ? []
      : await context.db
          .selectFrom("users")
          .select(ACCOUNT_COLUMNS)
          .where("deprovisionedAt", "is", null)
          .where("id", "<>", ERASED_USER_ID)
          .where(where)
          .orderBy("createdAt")
          .orderBy("id")
          .offset(page.offset)
          .limit(page.limit)
          .execute();
  return {
    total: total.value,
    resources: await userResources(context, accounts),
  };
}

export async function getScimUser(context: ScimContext, id: string) {
  const [resource] = await userResources(context, [
    await findAccount(context.db, id),
  ]);
  return resource;
}

/**
 * Keeps at least one active administrator: a provider cannot lock the
 * instance out by deactivating the last one.
 */
async function assertNotLastAdmin(tx: AuditTx, account: Account) {
  if (!account.isAdmin || account.disabledAt) return;
  const others = await tx
    .selectFrom("users")
    .select("id")
    .where("isAdmin", "=", true)
    .where("disabledAt", "is", null)
    .where("id", "<>", account.id)
    .forUpdate()
    .execute();
  if (others.length === 0) {
    throw new ScimError(
      400,
      "The last active administrator cannot be deactivated",
      "mutability",
    );
  }
}

/** Writes what the provider says the account is. */
async function saveAccount(tx: AuditTx, account: Account, next: ScimUserState) {
  if (!next.active) await assertNotLastAdmin(tx, account);
  if (next.email !== account.email) {
    const other = await tx
      .selectFrom("users")
      .select("id")
      .where("email", "=", next.email)
      .where("id", "<>", account.id)
      .executeTakeFirst();
    if (other) throw taken("This email");
  }
  await tx
    .updateTable("users")
    .set({
      email: next.email,
      displayName: next.displayName,
      scimUserName: next.userName,
      scimExternalId: next.externalId,
      deprovisionedAt: null,
      disabledAt: next.active ? null : (account.disabledAt ?? new Date()),
      // The identity provider's say, not an administrator's or inactivity's.
      disabledReason: null,
    })
    .where("id", "=", account.id)
    .execute();
  // A new address ends sessions and API tokens, so a reset link for the
  // old address cannot be redirected, and a stolen token does not outlive
  // the change. A deactivated account is signed out the same way.
  if (next.email !== account.email || !next.active) {
    await tx.deleteFrom("sessions").where("userId", "=", account.id).execute();
    await tx.deleteFrom("apiTokens").where("userId", "=", account.id).execute();
  }
}

/**
 * Creates an account, or takes over the one with the same email that no
 * provider keeps: one made before SCIM, or one the provider removed.
 */
export async function createScimUser(context: ScimContext, body: unknown) {
  const next = parseScimUser(body);
  const id = await change(context, async (tx) => {
    const existing = await tx
      .selectFrom("users")
      .select(ACCOUNT_COLUMNS)
      .where((eb) =>
        eb.or([
          eb("email", "=", next.email),
          sql<SqlBool>`lower(scim_user_name) = lower(${next.userName})`,
        ]),
      )
      .forUpdate()
      .execute();
    if (existing.length > 1) throw taken("This user name or email");
    const [account] = existing;
    if (account) {
      if (account.scimUserName !== null && account.deprovisionedAt === null) {
        throw taken("This user name");
      }
      await saveAccount(tx, account, next);
      return account.id;
    }
    const created = await tx
      .insertInto("users")
      .values({
        email: next.email,
        displayName: next.displayName,
        scimUserName: next.userName,
        scimExternalId: next.externalId,
        disabledAt: next.active ? null : new Date(),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return created.id;
  });
  return getScimUser(context, id);
}

export async function replaceScimUser(
  context: ScimContext,
  id: string,
  body: unknown,
) {
  await change(context, async (tx) => {
    const account = await findAccount(tx, id, true);
    await saveAccount(tx, account, parseScimUser(body, stateOf(account)));
  });
  return getScimUser(context, id);
}

export async function patchScimUserById(
  context: ScimContext,
  id: string,
  operations: readonly ScimPatchOperation[],
) {
  await change(context, async (tx) => {
    const account = await findAccount(tx, id, true);
    await saveAccount(tx, account, patchScimUser(stateOf(account), operations));
  });
  return getScimUser(context, id);
}

/**
 * The provider removed the account: it is disabled, leaves its groups,
 * and is gone from SCIM. Its history, email, display name, and roles stay;
 * creating it again brings it back. This is not account erasure
 * (`eraseAccount`), which removes the person's identifiers.
 */
export async function deleteScimUser(context: ScimContext, id: string) {
  await change(context, async (tx) => {
    const account = await findAccount(tx, id, true);
    await assertNotLastAdmin(tx, account);
    const left = await tx
      .deleteFrom("groupMembers")
      .where("userId", "=", account.id)
      .returning("groupId")
      .execute();
    for (const { groupId } of left) await syncGroupBindings(tx, groupId);
    await tx
      .updateTable("users")
      .set({
        disabledAt: account.disabledAt ?? new Date(),
        disabledReason: null,
        deprovisionedAt: new Date(),
        scimUserName: null,
        scimExternalId: null,
      })
      .where("id", "=", account.id)
      .execute();
    await tx.deleteFrom("sessions").where("userId", "=", account.id).execute();
  });
}

/* ------------------------------------------------------------------ */
/* Groups                                                              */
/* ------------------------------------------------------------------ */

type GroupRecord = {
  id: string;
  displayName: string;
  externalId: string | null;
  provider: string | null;
  createdAt: Date;
  updatedAt: Date;
};

async function findGroup(db: Database | AuditTx, id: string, lock = false) {
  if (!UUID.test(id)) throw notFound();
  let query = db
    .selectFrom("groups")
    .selectAll()
    .where("id", "=", id)
    // Local groups are not SCIM resources (ADR 0070).
    .where("provider", "=", "scim");
  if (lock) query = query.forUpdate();
  const group = await query.executeTakeFirst();
  if (!group) throw notFound();
  return group;
}

async function groupResources(
  context: ScimContext,
  groups: readonly GroupRecord[],
  withMembers: boolean,
) {
  const members = new Map<string, Array<{ id: string; displayName: string }>>();
  if (withMembers && groups.length > 0) {
    const rows = await context.db
      .selectFrom("groupMembers as m")
      .innerJoin("users as u", "u.id", "m.userId")
      .select(["m.groupId", "u.id", "u.displayName"])
      .where(
        "m.groupId",
        "in",
        groups.map((group) => group.id),
      )
      .orderBy("u.createdAt")
      .execute();
    for (const row of rows) {
      const list = members.get(row.groupId) ?? [];
      list.push({ id: row.id, displayName: row.displayName });
      members.set(row.groupId, list);
    }
  }
  return groups.map((group) =>
    scimGroupResource(
      {
        id: group.id,
        displayName: group.displayName,
        externalId: group.externalId,
        created: group.createdAt,
        updated: group.updatedAt,
        ...(withMembers ? { members: members.get(group.id) ?? [] } : {}),
      },
      context.baseUrl,
    ),
  );
}

function groupCondition(filter: ScimFilter | null): Expression<SqlBool> {
  if (!filter) return sql<SqlBool>`true`;
  const value = filter.value;
  switch (filter.attribute) {
    case "id":
      return UUID.test(value)
        ? sql<SqlBool>`id = ${value}::uuid`
        : sql<SqlBool>`false`;
    case "externalId":
      return sql<SqlBool>`external_id = ${value}`;
    case "member":
      return UUID.test(value)
        ? sql<SqlBool>`exists (select 1 from group_members m where m.group_id = groups.id and m.user_id = ${value}::uuid)`
        : sql<SqlBool>`false`;
    default:
      return sql<SqlBool>`lower(display_name) = lower(${value})`;
  }
}

export async function listScimGroups(
  context: ScimContext,
  filter: ScimFilter | null,
  page: { offset: number; limit: number },
  withMembers: boolean,
) {
  const where = groupCondition(filter);
  const scimOnly = sql<SqlBool>`provider = 'scim'`;
  const total = await context.db
    .selectFrom("groups")
    .select(sql<number>`count(*)::int`.as("value"))
    .where(where)
    .where(scimOnly)
    .executeTakeFirstOrThrow();
  const groups =
    page.limit === 0
      ? []
      : await context.db
          .selectFrom("groups")
          .selectAll()
          .where(where)
          .where(scimOnly)
          .orderBy("createdAt")
          .orderBy("id")
          .offset(page.offset)
          .limit(page.limit)
          .execute();
  return {
    total: total.value,
    resources: await groupResources(context, groups, withMembers),
  };
}

export async function getScimGroup(
  context: ScimContext,
  id: string,
  withMembers = true,
) {
  const [resource] = await groupResources(
    context,
    [await findGroup(context.db, id)],
    withMembers,
  );
  return resource;
}

/** Sets a group's members to `ids`: every one an account the provider keeps. */
async function setMembers(
  tx: AuditTx,
  groupId: string,
  ids: readonly string[],
) {
  const wanted = new Set(ids);
  if ([...wanted].some((id) => !UUID.test(id))) {
    throw new ScimError(400, "Unknown member", "invalidValue");
  }
  for (let start = 0; start < ids.length; start += 1_000) {
    const chunk = [...wanted].slice(start, start + 1_000);
    if (chunk.length === 0) break;
    const found = await tx
      .selectFrom("users")
      .select("id")
      .where("id", "in", chunk)
      .where("deprovisionedAt", "is", null)
      .execute();
    if (found.length !== chunk.length) {
      throw new ScimError(400, "Unknown member", "invalidValue");
    }
  }
  const current = await tx
    .selectFrom("groupMembers")
    .select("userId")
    .where("groupId", "=", groupId)
    .execute();
  const have = new Set(current.map((row) => row.userId));
  const leaving = [...have].filter((id) => !wanted.has(id));
  const joining = [...wanted].filter((id) => !have.has(id));
  for (let start = 0; start < leaving.length; start += 1_000) {
    await tx
      .deleteFrom("groupMembers")
      .where("groupId", "=", groupId)
      .where("userId", "in", leaving.slice(start, start + 1_000))
      .execute();
  }
  for (let start = 0; start < joining.length; start += 1_000) {
    await tx
      .insertInto("groupMembers")
      .values(
        joining
          .slice(start, start + 1_000)
          .map((userId) => ({ groupId, userId })),
      )
      .execute();
  }
  if (leaving.length > 0 || joining.length > 0) {
    await syncGroupBindings(tx, groupId);
  }
}

async function saveGroup(
  tx: AuditTx,
  groupId: string,
  current: ScimGroupState,
  next: ScimGroupState,
) {
  if (
    next.displayName !== current.displayName ||
    next.externalId !== current.externalId
  ) {
    await tx
      .updateTable("groups")
      .set({
        displayName: next.displayName,
        externalId: next.externalId,
        updatedAt: new Date(),
      })
      .where("id", "=", groupId)
      .execute();
  }
  await setMembers(tx, groupId, next.members);
}

async function groupState(
  tx: AuditTx,
  group: GroupRecord,
): Promise<ScimGroupState> {
  const members = await tx
    .selectFrom("groupMembers")
    .select("userId")
    .where("groupId", "=", group.id)
    .execute();
  return {
    displayName: group.displayName,
    externalId: group.externalId,
    members: members.map((row) => row.userId),
  };
}

export async function createScimGroup(context: ScimContext, body: unknown) {
  const next = parseScimGroup(body);
  const id = await change(context, async (tx) => {
    const created = await tx
      .insertInto("groups")
      .values({
        displayName: next.displayName,
        externalId: next.externalId,
        provider: "scim",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await setMembers(tx, created.id, next.members);
    return created.id;
  });
  return getScimGroup(context, id);
}

export async function replaceScimGroup(
  context: ScimContext,
  id: string,
  body: unknown,
) {
  const next = parseScimGroup(body);
  await change(context, async (tx) => {
    const group = await findGroup(tx, id, true);
    await saveGroup(tx, group.id, await groupState(tx, group), next);
  });
  return getScimGroup(context, id);
}

export async function patchScimGroupById(
  context: ScimContext,
  id: string,
  operations: readonly ScimPatchOperation[],
): Promise<void> {
  await change(context, async (tx) => {
    const group = await findGroup(tx, id, true);
    const current = await groupState(tx, group);
    await saveGroup(tx, group.id, current, patchScimGroup(current, operations));
  });
}

/** A group goes with its roles and the bindings it gave. */
export async function deleteScimGroup(context: ScimContext, id: string) {
  await change(context, async (tx) => {
    const group = await findGroup(tx, id, true);
    await tx.deleteFrom("groups").where("id", "=", group.id).execute();
  });
}
