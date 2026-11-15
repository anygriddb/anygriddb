/**
 * Reconstructs a person's roles on each base and table at a chosen instant
 * by walking backward from the roles they hold now (including roles a group
 * gives them). Incomplete when the change trail was purged before that date.
 */
import type { Database, Role } from "@anygriddb/db";
import { sql } from "kysely";

export type RightsAtLine = {
  scope: "base" | "table";
  scopeId: string;
  role: Role;
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

function bindingFromPayload(payload: Record<string, unknown> | null): {
  userId: string;
  scope: "base" | "table";
  scopeId: string;
  role: Role;
  groupId: string | null;
} | null {
  if (!payload) return null;
  if (!("scope" in payload) || !("role" in payload)) return null;
  const userId = textField(payload, "user_id", "userId");
  const scope = textField(payload, "scope");
  const scopeId = textField(payload, "scope_id", "scopeId");
  const role = textField(payload, "role");
  const groupId = textField(payload, "group_id", "groupId");
  if (!userId || (scope !== "base" && scope !== "table") || !scopeId || !role) {
    return null;
  }
  return {
    userId,
    scope,
    scopeId,
    role: role as Role,
    groupId,
  };
}

type StateRow = {
  scope: "base" | "table";
  scopeId: string;
  role: Role;
  groupId: string | null;
  groupName: string | null;
  eventId: string | null;
  occurredAt: Date | null;
};

/**
 * Rights the person held at `at`. Starts from what they hold now (own
 * bindings and those a group gives), then undoes every role_bindings change
 * after that date. Incomplete when the oldest kept catalog event is after
 * `at`.
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
    .where("catalogTable", "=", "role_bindings")
    .executeTakeFirst();
  const earliestKept = earliest?.at ? new Date(earliest.at) : null;

  const current = await db
    .selectFrom("roleBindings as b")
    .leftJoin("groups as g", "g.id", "b.groupId")
    .select([
      "b.role",
      "b.scope",
      "b.scopeId",
      "b.groupId",
      "g.displayName as groupName",
    ])
    .where("b.userId", "=", input.userId)
    .where("b.scope", "in", ["base", "table"])
    .execute();

  const state = new Map<BindingKey, StateRow>();
  for (const row of current) {
    const scope = row.scope as "base" | "table";
    state.set(keyOf(scope, row.scopeId, row.groupId), {
      scope,
      scopeId: row.scopeId,
      role: row.role,
      groupId: row.groupId,
      groupName: row.groupName,
      eventId: null,
      occurredAt: null,
    });
  }

  // No role_bindings event left, but the person still holds roles: the
  // trail was purged. A date before the oldest kept event is the same.
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

  // Newest first: undo each change that happened after the chosen instant.
  const events = await db
    .selectFrom("auditEvents")
    .select(["id", "occurredAt", "oldValue", "newValue"])
    .where("action", "=", "catalog")
    .where("catalogTable", "=", "role_bindings")
    .where("occurredAt", ">", input.at)
    .where((eb) =>
      eb.or([
        sql<boolean>`coalesce(new_value->>'user_id', new_value->>'userId') = ${input.userId}`,
        sql<boolean>`coalesce(old_value->>'user_id', old_value->>'userId') = ${input.userId}`,
      ]),
    )
    // A role change deletes the binding and inserts the new one in one
    // transaction, so both events share occurred_at. The id is a random
    // uuid and does not say which was last: the insert, which has a new
    // value, is the later write and is undone first.
    .orderBy("occurredAt", "desc")
    .orderBy(sql`case when new_value is null then 1 else 0 end`)
    .orderBy("id", "desc")
    .execute();

  for (const event of events) {
    const after = bindingFromPayload(payloadOf(event.newValue));
    const before = bindingFromPayload(payloadOf(event.oldValue));
    if (after && after.userId === input.userId) {
      state.delete(keyOf(after.scope, after.scopeId, after.groupId));
    }
    if (before && before.userId === input.userId) {
      state.set(keyOf(before.scope, before.scopeId, before.groupId), {
        scope: before.scope,
        scopeId: before.scopeId,
        role: before.role,
        groupId: before.groupId,
        groupName: null,
        eventId: event.id,
        occurredAt: event.occurredAt,
      });
    }
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

  const lines: RightsAtLine[] = [...state.values()]
    .map((row) => ({
      scope: row.scope,
      scopeId: row.scopeId,
      role: row.role,
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
    "scope,scope_id,base,table,role,group_id,group_name,event_id,occurred_at";
  const rows = result.lines.map((line) => {
    const names = labels.get(line.scopeId) ?? {};
    return [
      line.scope,
      line.scopeId,
      names.base ?? "",
      names.table ?? "",
      line.role,
      line.groupId ?? "",
      line.groupName ?? "",
      line.eventId ?? "",
      line.occurredAt ?? "",
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
