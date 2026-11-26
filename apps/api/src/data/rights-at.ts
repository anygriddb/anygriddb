/**
 * Reconstructs a person's roles on each base and table at a chosen instant
 * by walking backward from the roles they hold now (including roles a group
 * gives them). Incomplete when the change trail was purged before that date.
 */
import { type Permission, PERMISSIONS, rolePermissions } from "@anygriddb/core";
import type { Database, Role } from "@anygriddb/db";
import { sql } from "kysely";

export type RightsAtLine = {
  scope: "base" | "table";
  scopeId: string;
  /** One of the four, or null for a made role (ADR 0128). */
  role: Role | null;
  /**
   * The made role: its name and what it gave at that date, as the change
   * trail kept them; its name now when the trail no longer says (null:
   * since deleted), and its permissions then null.
   */
  madeRole: {
    id: string;
    name: string | null;
    permissions: Permission[] | null;
  } | null;
  /** Null when the role is the person's own; set when a group still gives it. */
  groupId: string | null;
  groupName: string | null;
  eventId: string | null;
  occurredAt: string | null;
};

export type RightsAtResult =
  | {
      incomplete: true;
      reason: "purged";
      earliestKept: string | null;
      at: string;
    }
  | {
      incomplete: false;
      at: string;
      lines: RightsAtLine[];
    };

type BindingKey = string;

function keyOf(
  scope: string,
  scopeId: string,
  groupId: string | null,
): BindingKey {
  return `${scope}:${scopeId}:${groupId ?? "direct"}`;
}

function payloadOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function textField(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** A role as an event of the trail kept it: whose, where, and which. */
function attributionFromPayload(payload: Record<string, unknown> | null): {
  userId: string | null;
  groupId: string | null;
  scope: "base" | "table";
  scopeId: string;
  role: Role | null;
  madeRoleId: string | null;
} | null {
  if (!payload) return null;
  if (!("scope" in payload) || !("role" in payload)) return null;
  const userId = textField(payload, "user_id", "userId");
  const groupId = textField(payload, "group_id", "groupId");
  const scope = textField(payload, "scope");
  const scopeId = textField(payload, "scope_id", "scopeId");
  const role = textField(payload, "role");
  const madeRoleId = textField(payload, "made_role_id", "madeRoleId");
  if (
    (!userId && !groupId) ||
    (scope !== "base" && scope !== "table") ||
    !scopeId ||
    (!role && !madeRoleId)
  ) {
    return null;
  }
  return {
    userId,
    groupId,
    scope,
    scopeId,
    role: role ? (role as Role) : null,
    madeRoleId: role ? null : madeRoleId,
  };
}

type StateRow = {
  scope: "base" | "table";
  scopeId: string;
  role: Role | null;
  madeRoleId: string | null;
  groupId: string | null;
  groupName: string | null;
  eventId: string | null;
  occurredAt: Date | null;
};

type TrailEvent = {
  id: string;
  occurredAt: Date;
  oldValue: unknown;
  newValue: unknown;
};

/** The roles of the trail, as each version kept them (ADR 0131). */
const ROLE_TRAILS = ["role_bindings", "attributions"] as const;

/**
 * When roles began to add up on this instance (migration 0150): before it,
 * a person's roles are read back from `bindings_before_union`, the roles
 * as they stood then, a group's copies included.
 */
async function unionSince(db: Database): Promise<Date | null> {
  const { rows } = await sql<{ appliedAt: Date }>`
    select applied_at as "appliedAt" from schema_migrations
    where name = '0150_attributions'
  `.execute(db);
  return rows[0]?.appliedAt ?? null;
}

/** Events of one trail after `at`, newest first, that match `whose`. */
async function eventsAfter(
  db: Database,
  table: string,
  at: Date,
  whose: ReturnType<typeof sql<boolean>>,
  until?: Date,
): Promise<TrailEvent[]> {
  return (
    db
      .selectFrom("auditEvents")
      .select(["id", "occurredAt", "oldValue", "newValue"])
      .where("action", "=", "catalog")
      .where("catalogTable", "=", table)
      .where("occurredAt", ">", at)
      .$if(until !== undefined, (query) =>
        query.where("occurredAt", "<=", until ?? at),
      )
      .where(whose)
      // A role change deletes the binding and inserts the new one in one
      // transaction, so both events share occurred_at. The id is a random
      // uuid and does not say which was last: the insert, which has a new
      // value, is the later write and is undone first.
      .orderBy("occurredAt", "desc")
      .orderBy(sql`case when new_value is null then 1 else 0 end`)
      .orderBy("id", "desc")
      .execute()
  );
}

/** Undoes each role change of `events` on `state`, for whom `mine` says. */
function undo(
  state: Map<BindingKey, StateRow>,
  events: readonly TrailEvent[],
  mine: (row: { userId: string | null; groupId: string | null }) => boolean,
): void {
  for (const event of events) {
    const after = attributionFromPayload(payloadOf(event.newValue));
    const before = attributionFromPayload(payloadOf(event.oldValue));
    if (after && mine(after)) {
      state.delete(keyOf(after.scope, after.scopeId, after.groupId));
    }
    if (before && mine(before)) {
      state.set(keyOf(before.scope, before.scopeId, before.groupId), {
        scope: before.scope,
        scopeId: before.scopeId,
        role: before.role,
        madeRoleId: before.madeRoleId,
        groupId: before.groupId,
        groupName: null,
        eventId: event.id,
        occurredAt: event.occurredAt,
      });
    }
  }
}

function stateOf(
  rows: ReadonlyArray<{
    scope: string | null;
    scopeId: string | null;
    role: Role | null;
    madeRoleId: string | null;
    groupId: string | null;
  }>,
): Map<BindingKey, StateRow> {
  const state = new Map<BindingKey, StateRow>();
  for (const row of rows) {
    if (row.scope !== "base" && row.scope !== "table") continue;
    if (row.scopeId === null) continue;
    state.set(keyOf(row.scope, row.scopeId, row.groupId), {
      scope: row.scope,
      scopeId: row.scopeId,
      role: row.role,
      madeRoleId: row.madeRoleId,
      groupId: row.groupId,
      groupName: null,
      eventId: null,
      occurredAt: null,
    });
  }
  return state;
}

/**
 * Before roles added up: the roles as they stood at the upgrade, a
 * group's copies included, then every change after `at` undone.
 */
async function stateBeforeUnion(
  db: Database,
  userId: string,
  at: Date,
  union: Date,
): Promise<Map<BindingKey, StateRow>> {
  const state = stateOf(
    await db
      .selectFrom("bindingsBeforeUnion")
      .select(["scope", "scopeId", "role", "madeRoleId", "groupId"])
      .where("userId", "=", userId)
      .execute(),
  );
  undo(
    state,
    await eventsAfter(
      db,
      "role_bindings",
      at,
      sql<boolean>`coalesce(new_value->>'user_id', new_value->>'userId', old_value->>'user_id', old_value->>'userId') = ${userId}`,
      union,
    ),
    (row) => row.userId === userId,
  );
  return state;
}

/**
 * Since roles add up: the person's own attributions and those of the
 * groups they were in at `at`, each walked back from now.
 */
async function stateSinceUnion(
  db: Database,
  userId: string,
  at: Date,
): Promise<Map<BindingKey, StateRow>> {
  const groups = new Set(
    (
      await db
        .selectFrom("groupMembers")
        .select("groupId")
        .where("userId", "=", userId)
        .execute()
    ).map((row) => row.groupId),
  );
  const joins = await eventsAfter(
    db,
    "group_members",
    at,
    sql<boolean>`coalesce(new_value->>'user_id', old_value->>'user_id') = ${userId}`,
  );
  for (const event of joins) {
    const joined = payloadOf(event.newValue);
    const left = payloadOf(event.oldValue);
    const joinedGroup = joined ? textField(joined, "group_id") : null;
    const leftGroup = left ? textField(left, "group_id") : null;
    if (joinedGroup) groups.delete(joinedGroup);
    if (leftGroup) groups.add(leftGroup);
  }
  const held = [...groups];
  const state = stateOf(
    await db
      .selectFrom("attributions")
      .select(["scope", "scopeId", "role", "madeRoleId", "groupId"])
      .where((eb) =>
        eb.or([
          eb("userId", "=", userId),
          ...(held.length > 0 ? [eb("groupId", "in", held)] : []),
        ]),
      )
      .execute(),
  );
  const theirs = sql<boolean>`(coalesce(new_value->>'user_id', old_value->>'user_id') = ${userId}${
    held.length > 0
      ? sql` or coalesce(new_value->>'group_id', old_value->>'group_id') = any(${held}::text[])`
      : sql``
  })`;
  undo(
    state,
    await eventsAfter(db, "attributions", at, theirs),
    (row) =>
      row.userId === userId ||
      (row.groupId !== null && groups.has(row.groupId)),
  );
  return state;
}

/**
 * Rights the person held at `at`, theirs and their groups'. Before the
 * upgrade where roles began to add up (ADR 0131), read back from the roles
 * as they stood then. Incomplete when the oldest kept event of the roles
 * is after `at`.
 */
export async function rightsAt(
  db: Database,
  input: { userId: string; at: Date },
): Promise<RightsAtResult> {
  const atIso = input.at.toISOString();
  const earliest = await db
    .selectFrom("auditEvents")
    .select((eb) => eb.fn.min<Date | null>("occurredAt").as("at"))
    .where("action", "=", "catalog")
    .where("catalogTable", "in", [...ROLE_TRAILS])
    .executeTakeFirst();
  const earliestKept = earliest?.at ? new Date(earliest.at) : null;
  const union = await unionSince(db);
  const state =
    union !== null && input.at.getTime() < union.getTime()
      ? await stateBeforeUnion(db, input.userId, input.at, union)
      : await stateSinceUnion(db, input.userId, input.at);

  // No role event left, but the person holds roles: the trail was
  // purged. A date before the oldest kept event is the same.
  if (
    (state.size > 0 && !earliestKept) ||
    (earliestKept && earliestKept.getTime() > input.at.getTime())
  ) {
    return {
      incomplete: true,
      reason: "purged",
      earliestKept: earliestKept ? earliestKept.toISOString() : null,
      at: atIso,
    };
  }

  // Fill group names for rows restored from the trail.
  const groupIds = [
    ...new Set(
      [...state.values()]
        .map((row) => row.groupId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (groupIds.length > 0) {
    const groups = await db
      .selectFrom("groups")
      .select(["id", "displayName"])
      .where("id", "in", groupIds)
      .execute();
    const names = new Map(groups.map((group) => [group.id, group.displayName]));
    for (const row of state.values()) {
      if (row.groupId && !row.groupName) {
        row.groupName = names.get(row.groupId) ?? null;
      }
    }
  }

  const madeIds = [
    ...new Set(
      [...state.values()]
        .map((row) => row.madeRoleId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const madeNames = new Map(
    madeIds.length === 0
      ? []
      : (
          await db
            .selectFrom("madeRoles")
            .select(["id", "name"])
            .where("id", "in", madeIds)
            .execute()
        ).map((role) => [role.id, role.name] as const),
  );
  const madeThen = await madeRolesAt(db, madeIds, input.at);
  const lines: RightsAtLine[] = [...state.values()]
    .map((row) => ({
      scope: row.scope,
      scopeId: row.scopeId,
      role: row.role,
      madeRole:
        row.madeRoleId === null
          ? null
          : {
              id: row.madeRoleId,
              name:
                madeThen.get(row.madeRoleId)?.name ??
                madeNames.get(row.madeRoleId) ??
                null,
              permissions: madeThen.get(row.madeRoleId)?.permissions ?? null,
            },
      groupId: row.groupId,
      groupName: row.groupName,
      eventId: row.eventId,
      occurredAt: row.occurredAt?.toISOString() ?? null,
    }))
    .sort((left, right) =>
      left.scope === right.scope
        ? left.scopeId.localeCompare(right.scopeId)
        : left.scope.localeCompare(right.scope),
    );

  return { incomplete: false, at: atIso, lines };
}

/**
 * What each made role was at a date: its name and permissions in the last
 * change the trail kept of it up to then, in one read of the trail.
 */
async function madeRolesAt(
  db: Database,
  ids: readonly string[],
  at: Date,
): Promise<Map<string, { name: string; permissions: Permission[] }>> {
  if (ids.length === 0) return new Map();
  const kept = sql<string>`coalesce(new_value, old_value) ->> 'id'`;
  const events = await db
    .selectFrom("auditEvents")
    .select([kept.as("roleId"), "newValue"])
    .distinctOn(kept)
    .where("action", "=", "catalog")
    .where("catalogTable", "=", "made_roles")
    .where("occurredAt", "<=", at)
    .where(kept, "in", ids)
    .orderBy(kept)
    .orderBy("occurredAt", "desc")
    .orderBy("id", "desc")
    .execute();
  const out = new Map<string, { name: string; permissions: Permission[] }>();
  for (const event of events) {
    const then = payloadOf(event.newValue);
    if (!then) continue;
    const name = typeof then.name === "string" ? then.name : null;
    const listed = Array.isArray(then.permissions) ? then.permissions : [];
    if (name === null) continue;
    out.set(event.roleId, {
      name,
      permissions: PERMISSIONS.filter((permission) =>
        listed.includes(permission),
      ),
    });
  }
  return out;
}

/** What a line's role gave at its date, by the permissions' keys. */
function permissionsOf(line: RightsAtLine): string {
  if (line.role) return rolePermissions(line.role).join(" ");
  return line.madeRole?.permissions?.join(" ") ?? "";
}

/**
 * One CSV cell. A leading = + - @ or tab would be a formula in a
 * spreadsheet, so it is prefixed; quotes are doubled.
 */
export function rightsAtCsvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** CSV of a complete rights-at report. */
export function rightsAtCsv(
  result: Extract<RightsAtResult, { incomplete: false }>,
  labels: Map<string, { base?: string; table?: string }>,
): string {
  const header =
    "scope,scope_id,base,table,role,group_id,group_name,event_id,occurred_at,permissions";
  const rows = result.lines.map((line) => {
    const names = labels.get(line.scopeId) ?? {};
    return [
      line.scope,
      line.scopeId,
      names.base ?? "",
      names.table ?? "",
      line.role ?? line.madeRole?.name ?? line.madeRole?.id ?? "",
      line.groupId ?? "",
      line.groupName ?? "",
      line.eventId ?? "",
      line.occurredAt ?? "",
      permissionsOf(line),
    ]
      .map(rightsAtCsvCell)
      .join(",");
  });
  return [header, ...rows].join("\n");
}

/** Resolves base/table names for CSV export. */
export async function rightsAtLabels(
  db: Database,
  lines: RightsAtLine[],
): Promise<Map<string, { base?: string; table?: string }>> {
  const baseIds = lines
    .filter((line) => line.scope === "base")
    .map((line) => line.scopeId);
  const tableIds = lines
    .filter((line) => line.scope === "table")
    .map((line) => line.scopeId);
  const out = new Map<string, { base?: string; table?: string }>();
  if (baseIds.length > 0) {
    const bases = await db
      .selectFrom("bases")
      .select(["id", "name"])
      .where("id", "in", baseIds)
      .execute();
    for (const base of bases) out.set(base.id, { base: base.name });
  }
  if (tableIds.length > 0) {
    const tables = await db
      .selectFrom("dataTables as t")
      .innerJoin("bases as b", "b.id", "t.baseId")
      .select(["t.id", "t.name as table", "b.name as base"])
      .where("t.id", "in", tableIds)
      .execute();
    for (const table of tables) {
      out.set(table.id, { base: table.base, table: table.table });
    }
  }
  return out;
}
