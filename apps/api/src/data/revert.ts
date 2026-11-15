/**
 * Earlier versions of a catalog object, and putting one back (ADR 0089).
 * The trail holds the before. The write goes through the function that
 * already changes that object.
 */
import {
  AppError,
  asPayload,
  auditValue,
  dashboardWidgetConfigSchema,
  earlierChanges,
  type EarlierChange,
  normalizeViewConfig,
  REVERT_CATALOG_TABLE,
  type RevertKind,
  sameDocument,
  updateAutomationInputSchema,
} from "@anygriddb/core";
import type { Database, TableRow, ViewRow } from "@anygriddb/db";
import { sql } from "kysely";
import { assertAutomation, saveAutomation } from "../automations.js";
import type { KeyRing } from "../auth/key-ring.js";
import { updateDashboard, upsertWidget } from "./dashboards.js";
import { loadEngine, type ColumnRow } from "./engine.js";
import { updateFolder } from "./folders.js";
import {
  liveBase,
  liveColumn,
  liveFolder,
  liveTable,
  liveView,
} from "./live.js";
import { updateBase, updateColumn, updateTable } from "./schema-ops.js";
import { updateView } from "./views.js";
import { assertPublicHttps, updateWebhook } from "../webhooks.js";

const SOURCE = "revert";

export type EarlierEvent = {
  id: string;
  occurredAt: string;
  displayName: string | null;
  verb: "created" | "edited" | "removed";
  source: string | null;
  changes: EarlierChange[];
  canRevertAll: boolean;
};

type Seen = Record<string, unknown>;

export type LoadedRevert = {
  baseId: string;
  tableId: string | null;
  /** What is stored now, in the names the API uses. */
  current: Seen;
  /** A personal view is not on the trail. */
  personal: boolean;
  table: TableRow | null;
  column: ColumnRow | null;
  view: ViewRow | null;
};

export async function locateRevert(
  db: Database,
  kind: RevertKind,
  id: string,
): Promise<LoadedRevert> {
  switch (kind) {
    case "base": {
      const row = await db
        .selectFrom("bases")
        .selectAll()
        .where("id", "=", id)
        .where(liveBase())
        .executeTakeFirst();
      if (!row) throw new AppError("no_row");
      return blank({
        baseId: row.id,
        current: { name: row.name, description: row.description },
      });
    }
    case "table": {
      const table = await liveTableRow(db, id);
      return blank({
        baseId: table.baseId,
        tableId: table.id,
        current: { name: table.name, description: table.description },
        table,
      });
    }
    case "column": {
      const column = await db
        .selectFrom("dataColumns")
        .selectAll()
        .where("id", "=", id)
        .where(liveColumn())
        .executeTakeFirst();
      if (!column) throw new AppError("unknown_column");
      const table = await liveTableRow(db, column.tableId);
      return blank({
        baseId: table.baseId,
        tableId: table.id,
        current: {
          label: column.label,
          description: column.description,
          config: column.config,
          requireReason: column.requireReason,
          required: column.required,
          isUnique: column.isUnique,
          fieldType: column.fieldType,
        },
        table,
        column,
      });
    }
    case "view": {
      const view = await db
        .selectFrom("views")
        .selectAll()
        .where("id", "=", id)
        .where(liveView())
        .executeTakeFirst();
      if (!view) throw new AppError("no_row");
      const table = await liveTableRow(db, view.tableId);
      return blank({
        baseId: table.baseId,
        tableId: table.id,
        current: {
          name: view.name,
          config: view.config,
          viewType: view.viewType,
        },
        personal: view.ownerId !== null,
        table,
        view,
      });
    }
    case "folder": {
      const folder = await db
        .selectFrom("tableFolders")
        .selectAll()
        .where("id", "=", id)
        .where(liveFolder())
        .executeTakeFirst();
      if (!folder) throw new AppError("unknown_folder");
      return blank({
        baseId: folder.baseId,
        current: { name: folder.name },
      });
    }
    case "dashboard": {
      const row = await db
        .selectFrom("dashboards")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) throw new AppError("unknown_dashboard");
      return blank({
        baseId: row.baseId,
        current: { name: row.name, description: row.description },
      });
    }
    case "widget": {
      const widget = await db
        .selectFrom("dashboardWidgets")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!widget) throw new AppError("unknown_widget");
      const dashboard = await db
        .selectFrom("dashboards")
        .select(["baseId"])
        .where("id", "=", widget.dashboardId)
        .executeTakeFirst();
      if (!dashboard) throw new AppError("unknown_dashboard");
      return blank({
        baseId: dashboard.baseId,
        current: {
          title: widget.title,
          kind: widget.kind,
          config: widget.config,
          x: widget.x,
          y: widget.y,
          w: widget.w,
          h: widget.h,
          dashboardId: widget.dashboardId,
        },
      });
    }
    case "automation": {
      const row = await db
        .selectFrom("automations")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) throw new AppError("no_row");
      const table = await liveTableRow(db, row.tableId);
      return blank({
        baseId: table.baseId,
        tableId: table.id,
        current: {
          name: row.name,
          enabled: row.enabled,
          trigger: row.trigger,
          actions: row.actions,
        },
        table,
      });
    }
    case "webhook": {
      const row = await db
        .selectFrom("webhooks")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) throw new AppError("no_row");
      const table = await liveTableRow(db, row.tableId);
      return blank({
        baseId: table.baseId,
        tableId: table.id,
        current: {
          name: row.name,
          active: row.active,
          events: row.events,
          filter: row.filter,
          watchColumns: row.watchColumns,
          includeValues: row.includeValues,
          target: row.target,
          kind: row.kind,
        },
        table,
      });
    }
    default: {
      const exhaustive: never = kind;
      throw new AppError("revert_unavailable", exhaustive);
    }
  }
}

function blank(input: {
  baseId: string;
  tableId?: string | null;
  current: Seen;
  personal?: boolean;
  table?: TableRow | null;
  column?: ColumnRow | null;
  view?: ViewRow | null;
}): LoadedRevert {
  return {
    baseId: input.baseId,
    tableId: input.tableId ?? null,
    current: input.current,
    personal: input.personal ?? false,
    table: input.table ?? null,
    column: input.column ?? null,
    view: input.view ?? null,
  };
}

async function liveTableRow(db: Database, tableId: string): Promise<TableRow> {
  const table = await db
    .selectFrom("dataTables")
    .selectAll()
    .where("id", "=", tableId)
    .where(liveTable())
    .executeTakeFirst();
  if (!table) throw new AppError("no_row");
  return table;
}

export async function listEarlier(
  db: Database,
  kind: RevertKind,
  id: string,
  loaded: LoadedRevert,
): Promise<EarlierEvent[]> {
  if (loaded.personal) return [];
  const rows = await db
    .selectFrom("auditEvents as e")
    .innerJoin("users as u", "u.id", "e.userId")
    .select([
      "e.id",
      "e.occurredAt",
      "e.oldValue",
      "e.newValue",
      "e.source",
      "u.displayName",
    ])
    .where("e.action", "=", "catalog")
    .where("e.catalogTable", "=", REVERT_CATALOG_TABLE[kind])
    .where(
      sql<boolean>`coalesce(e.new_value->>'id', e.old_value->>'id') = ${id}`,
    )
    .orderBy("e.occurredAt", "desc")
    .limit(200)
    .execute();
  return rows.map((row) => {
    const gates = eventGates(kind, row.oldValue, loaded.current);
    const listed = earlierChanges({
      kind,
      oldValue: row.oldValue,
      newValue: row.newValue,
      blocked: gates.blocked,
      closed: gates.closed,
    });
    const oldPayload = asPayload(row.oldValue);
    const nextPayload = asPayload(row.newValue);
    return {
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      displayName: row.displayName,
      verb: !oldPayload ? "created" : !nextPayload ? "removed" : "edited",
      source: row.source,
      changes: listed.changes,
      canRevertAll: listed.canRevertAll,
    };
  });
}

function eventGates(
  kind: RevertKind,
  oldValue: unknown,
  current: Seen,
): { closed: boolean; blocked: Set<string> } {
  const old = asPayload(oldValue);
  const blocked = new Set<string>();
  if (kind === "column") {
    const then = auditValue(old, "fieldType");
    if (then !== undefined && then !== current.fieldType) {
      return { closed: true, blocked };
    }
  }
  if (kind === "view") {
    const then = auditValue(old, "viewType");
    if (then !== undefined && then !== current.viewType) {
      return { closed: true, blocked };
    }
  }
  if (kind === "webhook") {
    const then = auditValue(old, "kind");
    if (then !== undefined && then !== current.kind) {
      return { closed: true, blocked };
    }
  }
  if (kind === "widget") {
    const then = auditValue(old, "kind");
    if (then !== undefined && then !== current.kind) blocked.add("config");
  }
  return { closed: false, blocked };
}

export async function revertCatalog(
  db: Database,
  actorId: string,
  input: {
    kind: RevertKind;
    id: string;
    eventId: string;
    field?: string;
    seen: Seen;
  },
  loaded: LoadedRevert,
  key: KeyRing,
): Promise<void> {
  if (loaded.personal) throw new AppError("revert_unavailable");
  const event = await db
    .selectFrom("auditEvents")
    .select(["id", "oldValue", "newValue", "catalogTable"])
    .where("id", "=", input.eventId)
    .where("action", "=", "catalog")
    .where("catalogTable", "=", REVERT_CATALOG_TABLE[input.kind])
    .executeTakeFirst();
  const oldId = event ? payloadObjectId(event.oldValue, event.newValue) : null;
  if (!event || oldId !== input.id) throw new AppError("revert_unavailable");
  const gates = eventGates(input.kind, event.oldValue, loaded.current);
  const listed = earlierChanges({
    kind: input.kind,
    oldValue: event.oldValue,
    newValue: event.newValue,
    blocked: gates.blocked,
    closed: gates.closed,
  });
  const fields = fieldsToWrite(input.kind, input.field, listed);
  for (const field of fields) {
    if (!Object.hasOwn(input.seen, field)) throw new AppError("revert_stale");
    if (!sameDocument(loaded.current[field], input.seen[field])) {
      throw new AppError("revert_stale");
    }
  }
  const old = asPayload(event.oldValue);
  if (!old) throw new AppError("revert_unavailable");
  await applyRevert(
    db,
    actorId,
    input.kind,
    input.id,
    loaded,
    old,
    fields,
    key,
  );
}

function payloadObjectId(oldValue: unknown, newValue: unknown): string | null {
  const id = asPayload(newValue)?.id ?? asPayload(oldValue)?.id;
  return typeof id === "string" ? id : null;
}

function fieldsToWrite(
  kind: RevertKind,
  field: string | undefined,
  listed: { changes: EarlierChange[]; canRevertAll: boolean },
): string[] {
  if (field) {
    const change = listed.changes.find((item) => item.field === field);
    if (!change?.canRevert) throw new AppError("revert_unavailable");
    return [field];
  }
  if (!listed.canRevertAll) throw new AppError("revert_unavailable");
  if (kind === "widget") {
    const names = new Set(listed.changes.map((change) => change.field));
    if (names.has("kind") || names.has("config")) {
      return ["title", "kind", "config"];
    }
    return ["title"];
  }
  return listed.changes
    .filter((change) => change.canRevert)
    .map((change) => change.field);
}

async function applyRevert(
  db: Database,
  actorId: string,
  kind: RevertKind,
  id: string,
  loaded: LoadedRevert,
  old: Record<string, unknown>,
  fields: readonly string[],
  key: KeyRing,
): Promise<void> {
  const value = (field: string) => auditValue(old, field);
  switch (kind) {
    case "base":
      await updateBase(
        db,
        actorId,
        {
          baseId: id,
          ...(fields.includes("name")
            ? { name: requiredText(value("name")) }
            : {}),
          ...(fields.includes("description")
            ? { description: optionalText(value("description")) }
            : {}),
        },
        SOURCE,
      );
      return;
    case "table":
      await updateTable(
        db,
        actorId,
        {
          tableId: id,
          ...(fields.includes("name")
            ? { name: requiredText(value("name")) }
            : {}),
          ...(fields.includes("description")
            ? { description: optionalText(value("description")) }
            : {}),
        },
        SOURCE,
      );
      return;
    case "column": {
      const table = loaded.table;
      const column = loaded.column;
      if (!table || !column) throw new AppError("unknown_column");
      await updateColumn(
        db,
        actorId,
        table,
        {
          name: column.name,
          ...(fields.includes("label")
            ? { label: requiredText(value("label")) }
            : {}),
          ...(fields.includes("description")
            ? { description: optionalText(value("description")) }
            : {}),
          ...(fields.includes("config")
            ? { config: record(value("config")) }
            : {}),
          ...(fields.includes("requireReason")
            ? { requireReason: flag(value("requireReason")) }
            : {}),
          ...(fields.includes("required")
            ? { required: flag(value("required")) }
            : {}),
          ...(fields.includes("isUnique")
            ? { unique: flag(value("isUnique")) }
            : {}),
        },
        SOURCE,
      );
      return;
    }
    case "view": {
      const view = loaded.view;
      const table = loaded.table;
      if (!view || !table) throw new AppError("no_row");
      const { engine } = await loadEngine(db, table.id, () => true);
      await updateView(
        db,
        engine,
        actorId,
        view,
        {
          ...(fields.includes("name")
            ? { name: requiredText(value("name")) }
            : {}),
          ...(fields.includes("config")
            ? {
                config: normalizeViewConfig(value("config"), view.viewType),
              }
            : {}),
        },
        SOURCE,
      );
      return;
    }
    case "folder":
      await updateFolder(
        db,
        actorId,
        { folderId: id, name: requiredText(value("name")) },
        SOURCE,
      );
      return;
    case "dashboard":
      await updateDashboard(
        db,
        actorId,
        {
          dashboardId: id,
          ...(fields.includes("name")
            ? { name: requiredText(value("name")) }
            : {}),
          ...(fields.includes("description")
            ? { description: optionalText(value("description")) }
            : {}),
        },
        SOURCE,
      );
      return;
    case "widget": {
      const kindName = fields.includes("kind")
        ? requiredText(value("kind"))
        : requiredText(loaded.current.kind);
      const config = fields.includes("config")
        ? record(value("config"))
        : record(loaded.current.config);
      const parsed = dashboardWidgetConfigSchema.safeParse({
        kind: kindName,
        config,
      });
      if (!parsed.success) throw new AppError("revert_unavailable");
      const x = numberField(loaded.current.x);
      const y = numberField(loaded.current.y);
      const w = numberField(loaded.current.w);
      const h = numberField(loaded.current.h);
      const dashboardId = requiredText(loaded.current.dashboardId);
      await upsertWidget(
        db,
        actorId,
        loaded.baseId,
        {
          dashboardId,
          widgetId: id,
          title: fields.includes("title")
            ? requiredText(value("title"))
            : requiredText(loaded.current.title),
          kind: parsed.data.kind,
          config: parsed.data.config,
          x,
          y,
          w,
          h,
        },
        SOURCE,
      );
      return;
    }
    case "automation": {
      const table = loaded.table;
      if (!table) throw new AppError("no_row");
      const body = {
        automationId: id,
        name: fields.includes("name")
          ? requiredText(value("name"))
          : requiredText(loaded.current.name),
        enabled: fields.includes("enabled")
          ? flag(value("enabled"))
          : flag(loaded.current.enabled),
        trigger: fields.includes("trigger")
          ? value("trigger")
          : loaded.current.trigger,
        actions: fields.includes("actions")
          ? value("actions")
          : loaded.current.actions,
      };
      const parsed = updateAutomationInputSchema.safeParse(body);
      if (!parsed.success) throw new AppError("revert_unavailable");
      await assertAutomation(db, table, parsed.data);
      await saveAutomation(db, {
        id,
        tableId: table.id,
        createdBy: actorId,
        name: parsed.data.name,
        enabled: parsed.data.enabled,
        trigger: parsed.data.trigger,
        actions: parsed.data.actions,
        source: SOURCE,
      });
      return;
    }
    case "webhook": {
      const target = fields.includes("target")
        ? requiredText(value("target"))
        : null;
      if (target !== null && loaded.current.kind === "http") {
        await assertPublicHttps(target);
      }
      const events = fields.includes("events")
        ? stringList(value("events"))
        : undefined;
      await updateWebhook(db, key, actorId, id, {
        ...(fields.includes("name")
          ? { name: requiredText(value("name")) }
          : {}),
        ...(fields.includes("active") ? { active: flag(value("active")) } : {}),
        ...(events ? { events } : {}),
        ...(fields.includes("filter") ? { filter: value("filter") } : {}),
        ...(fields.includes("watchColumns")
          ? { watchColumns: stringListOrNull(value("watchColumns")) }
          : {}),
        ...(fields.includes("includeValues")
          ? { includeValues: flag(value("includeValues")) }
          : {}),
        ...(target !== null ? { target } : {}),
        source: SOURCE,
      });
      return;
    }
    default: {
      const exhaustive: never = kind;
      throw new AppError("revert_unavailable", exhaustive);
    }
  }
}

function requiredText(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new AppError("revert_unavailable");
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw new AppError("revert_unavailable");
}

function flag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new AppError("revert_unavailable");
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function numberField(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new AppError("revert_unavailable");
}

function stringList(value: unknown): string[] {
  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    value.length > 0
  ) {
    return value;
  }
  throw new AppError("revert_unavailable");
}

function stringListOrNull(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  throw new AppError("revert_unavailable");
}
