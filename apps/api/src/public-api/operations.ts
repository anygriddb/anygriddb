import { rulesOwner } from "../data/acting-context.js";
import {
  type Permission,
  andFilters,
  AppError,
  type CellValue,
  cellValueSchema,
  readCellValue,
  effectiveTableRole,
  type EngineCatalog,
  type FilterGroup,
  filterGroupSchema,
  isRelationType,
  isWritableType,
  normalizeViewConfig,
  pruneViewConfig,
  roleGrants,
  grantName,
  roleFor,
  rolePermissions,
  rowIdSchema,
  type RowSort,
  viewFilter,
} from "@anygriddb/core";
import { type Declaration, demand } from "../access/declaration.js";
import { z } from "zod";
import { enrichAttachments } from "../attachments.js";
import { readerEngine, readerEngines } from "../data/acl.js";
import type { CatalogRows, TableRow } from "../data/engine.js";
import {
  listCollaborators,
  readByIds,
  readPage,
  visibleFields,
  safeTimeZone,
  type RowRecord,
} from "../data/rows.js";
import { loadView } from "../data/views.js";
import { circuitKeysOf } from "../data/status-circuits.js";
import { liveBase, liveTable } from "../data/live.js";
import { attachExternalStatuses } from "../sources/statuses.js";
import { publicColumns } from "../trpc/catalog-shared.js";
import {
  createRows,
  deleteRows,
  findLiveTable,
  loadRowScope,
  transitionRowAs,
  updateRows,
  type RowScope,
  type RowServiceDeps,
} from "../services/rows.js";
import { buildOpenApi } from "./openapi.js";
import {
  type Actor,
  listQuerySchema,
  MAX_RECORDS,
  type PublicApiDeps,
} from "./types.js";

export const writeBodySchema = z.object({
  records: z
    .array(
      z.object({
        id: rowIdSchema.optional(),
        fields: z.record(z.string().max(100), z.unknown()),
        expected: z.record(z.string().max(100), z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(MAX_RECORDS),
  typecast: z.boolean().optional(),
  fieldKey: z.enum(["name", "label"]).optional(),
});

/**
 * Where a write comes from when a person did not send it to the API
 * themselves: an automation's script, named on the trail as the
 * automation's other writes are.
 */
export type WriteOrigin = {
  source: string;
  fixedReason?: string | null;
  depth?: number;
};

type PreparedWrite = {
  id?: string;
  values: Record<string, CellValue>;
  links: Array<{ column: string; ids: string[] }>;
  expected?: Record<string, CellValue>;
};

function serviceDeps(deps: PublicApiDeps): RowServiceDeps {
  return {
    db: deps.db,
    bus: deps.bus,
    log: deps.log,
  };
}

/**
 * What each operation of the API asks, for the REST route and the MCP
 * tool that run it: a token's calls are a session's, through a role that
 * lets a token in (`api.access`).
 */
export const OPERATION_ASKS = {
  listBases: { filters: ["rows.read"] },
  listTables: { filters: ["rows.read"] },
  openApiDocument: { filters: ["rows.read"] },
  listRecords: { asks: ["rows.read"], also: ["data.export"] },
  getRecord: { asks: ["rows.read"], also: ["data.export"] },
  createRecords: { asks: ["rows.read", "rows.write"] },
  updateRecords: { asks: ["rows.read", "rows.write"] },
  transitionRecord: { asks: ["rows.read", "rows.transition"] },
  deleteRecords: { asks: ["rows.read", "rows.delete"] },
} as const satisfies Record<string, Declaration>;
export type Operation = keyof typeof OPERATION_ASKS;

async function tableFor(
  deps: PublicApiDeps,
  actor: Actor,
  tableId: string,
  permission: Permission,
): Promise<TableRow> {
  const table = await findLiveTable(deps.db, tableId);
  const role = table
    ? effectiveTableRole(actor.bindings, table.id, table.baseId)
    : null;
  if (!table) throw new AppError("not_found");
  demand(role, "rows.read", "not_found");
  demand(role, permission);
  // Rows read through a token are an extraction (ADR 0131, §6).
  if (permission === "rows.read" && actor.scope) demand(role, "data.export");
  return table;
}

async function engineFor(
  deps: PublicApiDeps,
  actor: Actor,
  table: TableRow,
): Promise<{ engine: EngineCatalog; rows: CatalogRows }> {
  return readerEngine(deps.db, table.id, {
    userId: actor.user.id,
    bindings: actor.bindings,
  });
}

/** The engines of a base's tables, from one read of its catalog. */
function enginesFor(
  deps: PublicApiDeps,
  actor: Actor,
  tables: readonly TableRow[],
) {
  return readerEngines(
    deps.db,
    tables.map((table) => table.id),
    { userId: actor.user.id, bindings: actor.bindings },
  );
}

function keyMap(engine: EngineCatalog, mode: "name" | "label") {
  const columns = engine.table.columns.filter(
    (column) => !engine.access?.hidden(engine.table.id, column.name),
  );
  const toKey = new Map(
    columns.map((column) => [
      column.name,
      mode === "label" ? column.label : column.name,
    ]),
  );
  const fromKey = new Map(
    columns.map((column) => [
      mode === "label" ? column.label : column.name,
      column.name,
    ]),
  );
  return { toKey, fromKey };
}

export function presentRecord(
  row: RowRecord,
  engine: EngineCatalog,
  mode: "name" | "label",
  fields?: readonly string[],
) {
  const { toKey } = keyMap(engine, mode);
  const out: Record<string, unknown> = {};
  for (const column of engine.table.columns) {
    if (fields && !fields.includes(column.name)) continue;
    const value = row[column.name];
    if (
      value === null ||
      value === undefined ||
      (Array.isArray(value) && value.length === 0)
    )
      continue;
    out[toKey.get(column.name) ?? column.name] = value;
  }
  return {
    id: row.id,
    createdTime: row.ag_created_at ?? null,
    lastModifiedTime: row.ag_updated_at ?? null,
    status: row.ag_status,
    fields: out,
  };
}

function parseSort(
  raw: string | undefined,
  fromKey: Map<string, string>,
): RowSort[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((part) => {
      const direction: "asc" | "desc" = part.startsWith("-") ? "desc" : "asc";
      const key = part.replace(/^[-+]/, "");
      const column = fromKey.get(key);
      if (!column) throw new AppError("unknown_column", key);
      return { column, direction };
    });
}

function parseFilter(raw: string | undefined): FilterGroup | undefined {
  if (!raw) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AppError("invalid_filter");
  }
  const parsed = filterGroupSchema.safeParse(json);
  if (!parsed.success) throw new AppError("invalid_filter");
  return parsed.data;
}

async function prepareWrites(
  deps: PublicApiDeps,
  engine: EngineCatalog,
  table: TableRow,
  body: z.infer<typeof writeBodySchema>,
): Promise<PreparedWrite[]> {
  const { fromKey } = keyMap(engine, body.fieldKey ?? "name");
  const people = body.typecast
    ? await listCollaborators(deps.db, table.baseId)
    : [];
  const resolveUser = (text: string) => {
    const folded = text.trim().toLowerCase();
    return people.find((person) => person.displayName.toLowerCase() === folded)
      ?.id;
  };
  return body.records.map((record) => {
    const values: Record<string, CellValue> = {};
    const links: Array<{ column: string; ids: string[] }> = [];
    for (const [key, raw] of Object.entries(record.fields)) {
      const name = fromKey.get(key);
      const column = engine.table.columns.find((item) => item.name === name);
      if (!column) throw new AppError("unknown_column", key);
      if (isRelationType(column.fieldType)) {
        const ids: unknown[] = Array.isArray(raw)
          ? raw
          : raw === null
            ? []
            : [raw];
        const parsed = z
          .array(rowIdSchema)
          .max(500)
          .safeParse(
            ids.map((item) =>
              item && typeof item === "object" && "id" in item ? item.id : item,
            ),
          );
        if (!parsed.success) throw new AppError("invalid_relation");
        links.push({ column: column.name, ids: parsed.data });
        continue;
      }
      if (!isWritableType(column.fieldType))
        throw new AppError("formula_column_is_computed");
      if (body.typecast) {
        const reading = readCellValue(column, raw, { resolveUser });
        if ("refused" in reading) {
          // A date that reads two ways says which format to send.
          throw new AppError(
            reading.refused.code === "ambiguous_date"
              ? "ambiguous_date"
              : "invalid_cell",
            key,
          );
        }
        values[column.name] = reading.value;
      } else {
        const parsed = cellValueSchema.safeParse(raw);
        if (!parsed.success) throw new AppError("invalid_cell", key);
        values[column.name] = parsed.data;
      }
    }
    if (!record.expected) return { id: record.id, values, links };
    const expected: Record<string, CellValue> = {};
    for (const [key, raw] of Object.entries(record.expected)) {
      const name = fromKey.get(key);
      if (!name) throw new AppError("unknown_column", key);
      const parsed = cellValueSchema.safeParse(raw);
      if (!parsed.success) throw new AppError("invalid_cell", key);
      expected[name] = parsed.data;
    }
    return { id: record.id, values, links, expected };
  });
}

/** Record ids in a query string: comma list or JSON array. */
export function recordIds(raw: string): string[] | null {
  const text = raw.trim();
  if (text.startsWith("[")) {
    try {
      const list: unknown = JSON.parse(text);
      const parsed = z
        .array(rowIdSchema)
        .min(1)
        .max(MAX_RECORDS)
        .safeParse(list);
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON: one id that starts with a bracket.
    }
  }
  const parsed = z
    .array(rowIdSchema)
    .min(1)
    .max(MAX_RECORDS)
    .safeParse(
      text
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    );
  return parsed.success ? parsed.data : null;
}

async function readableBaseTables(
  deps: PublicApiDeps,
  actor: Actor,
  baseId: string,
) {
  const rows = await deps.db
    .selectFrom("dataTables as t")
    .innerJoin("bases as b", "b.id", "t.baseId")
    .selectAll("t")
    .where("t.baseId", "=", baseId)
    .where(liveTable("t"))
    .where(liveBase("b"))
    .execute();
  return rows.filter((table) =>
    roleGrants(
      effectiveTableRole(actor.bindings, table.id, table.baseId),
      "rows.read",
    ),
  );
}

export async function listBases(deps: PublicApiDeps, actor: Actor) {
  const ids = [
    ...new Set(
      actor.bindings
        .filter((binding) => binding.scope === "base")
        .map((binding) => binding.scopeId),
    ),
  ];
  const rows =
    ids.length === 0
      ? []
      : await deps.db
          .selectFrom("bases")
          .selectAll()
          .where("id", "in", ids)
          .where(liveBase())
          .execute();
  return {
    bases: rows.map((base) => {
      const held = roleFor(actor.bindings, "base", base.id);
      return {
        id: base.id,
        name: base.name,
        role: grantName(held),
        permissions: held ? rolePermissions(held) : [],
      };
    }),
  };
}

export async function listTables(
  deps: PublicApiDeps,
  actor: Actor,
  baseId: string,
) {
  const base = await deps.db
    .selectFrom("bases")
    .select("id")
    .where("id", "=", baseId)
    .where(liveBase())
    .executeTakeFirst();
  const list = await readableBaseTables(deps, actor, baseId);
  if (!base || (list.length === 0 && !roleFor(actor.bindings, "base", baseId)))
    throw new AppError("not_found");
  const { engineOf, rows, index } = await enginesFor(deps, actor, list);
  const out = [];
  for (const table of list.sort(
    (left, right) => left.position - right.position,
  )) {
    const engine = engineOf(table.id);
    out.push({
      id: table.id,
      name: table.name,
      fields: publicColumns(engine, rows, index).map((column) => ({
        name: column.name,
        label: column.label,
        type: column.fieldType,
        kind: column.kind,
        primary: column.isPrimary,
        /** A new record fills it; a change never empties it. */
        required: column.required,
        readOnly:
          !isWritableType(column.fieldType) &&
          !isRelationType(column.fieldType),
        config: column.config,
      })),
    });
  }
  return { tables: out };
}

export async function openApiDocument(
  deps: PublicApiDeps,
  actor: Actor,
  baseId: string,
) {
  const base = await deps.db
    .selectFrom("bases")
    .selectAll()
    .where("id", "=", baseId)
    .where(liveBase())
    .executeTakeFirst();
  const list = await readableBaseTables(deps, actor, baseId);
  if (!base || (list.length === 0 && !roleFor(actor.bindings, "base", baseId)))
    throw new AppError("not_found");
  const { engineOf, rows, index } = await enginesFor(deps, actor, list);
  const circuits = await circuitKeysOf(
    deps.db,
    list.map((table) => table.id),
  );
  const described = [];
  for (const table of list) {
    const engine = engineOf(table.id);
    described.push({
      id: table.id,
      name: table.name,
      external: table.storage === "external",
      columns: publicColumns(engine, rows, index),
      circuit: circuits.get(table.id),
    });
  }
  return buildOpenApi(base, described, deps.publicUrl);
}

export async function listRecords(
  deps: PublicApiDeps,
  actor: Actor,
  tableId: string,
  queryInput: unknown,
) {
  const query = listQuerySchema.safeParse(queryInput);
  if (!query.success) throw new AppError("invalid_query");
  const table = await tableFor(deps, actor, tableId, "rows.read");
  const { engine } = await engineFor(deps, actor, table);
  const { fromKey } = keyMap(engine, query.data.fieldKey);
  let viewConfig = normalizeViewConfig({});
  if (query.data.view) {
    const view = await loadView(deps.db, query.data.view);
    if (
      view.tableId !== table.id ||
      (view.ownerId && view.ownerId !== actor.user.id)
    )
      throw new AppError("invalid_view");
    viewConfig = pruneViewConfig(
      normalizeViewConfig(view.config, view.viewType),
      new Set(engine.table.columns.map((column) => column.name)),
    );
  }
  const fields = query.data.fields
    ?.split(",")
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key) => {
      const name = fromKey.get(key);
      if (!name) throw new AppError("unknown_column", key);
      return name;
    });
  const page = await readPage(
    deps.db,
    engine,
    {
      filter: andFilters(
        viewFilter(viewConfig),
        parseFilter(query.data.filter),
      ),
      sort: parseSort(query.data.sort, fromKey) ?? viewConfig.sort,
      search: query.data.search,
      fields,
      offset: query.data.offset,
      limit: query.data.limit,
      timeZone: safeTimeZone(query.data.timeZone),
      me: rulesOwner(actor.user.id),
    },
    { total: true, budget: actor.readBudget },
  );
  await enrichAttachments(
    deps.db,
    engine.table.id,
    engine.table.columns
      .filter((column) => column.fieldType === "attachment")
      .map((column) => column.name),
    page.rows,
  );
  await attachExternalStatuses(deps.db, engine, page.rows);
  return {
    records: page.rows.map((row) =>
      presentRecord(row, engine, query.data.fieldKey, fields),
    ),
    total: page.total ?? 0,
    offset: query.data.offset,
  };
}

export async function getRecord(
  deps: PublicApiDeps,
  actor: Actor,
  tableId: string,
  recordId: string,
  fieldKey: "name" | "label" = "name",
) {
  const table = await tableFor(deps, actor, tableId, "rows.read");
  const { engine } = await engineFor(deps, actor, table);
  const [row] = await readByIds(
    deps.db,
    engine,
    [recordId],
    "UTC",
    visibleFields(engine),
    actor.readBudget,
  );
  if (!row) throw new AppError("not_found");
  await attachExternalStatuses(deps.db, engine, [row]);
  await enrichAttachments(
    deps.db,
    engine.table.id,
    engine.table.columns
      .filter((column) => column.fieldType === "attachment")
      .map((column) => column.name),
    [row],
  );
  return presentRecord(row, engine, fieldKey);
}

async function scopeFor(
  deps: PublicApiDeps,
  actor: Actor,
  table: TableRow,
): Promise<RowScope> {
  return loadRowScope(
    deps.db,
    {
      userId: actor.user.id,
      bindings: actor.bindings,
      noDelete: actor.scope?.allowDelete === false,
    },
    table,
  );
}

export async function createRecords(
  deps: PublicApiDeps,
  actor: Actor,
  tableId: string,
  bodyInput: unknown,
  reason?: string,
  origin?: WriteOrigin,
) {
  const body = writeBodySchema.safeParse(bodyInput);
  if (!body.success) throw new AppError("invalid_body");
  const table = await tableFor(deps, actor, tableId, "rows.write");
  const scope = await scopeFor(deps, actor, table);
  const prepared = await prepareWrites(deps, scope.engine, table, body.data);
  const meta = origin ?? { reason, source: "api" as const };
  const rows = prepared.map((record) => ({
    values: record.values,
    links: record.links.map((link) => ({
      column: link.column,
      targetIds: link.ids,
    })),
  }));
  const ids = await createRows(serviceDeps(deps), scope, rows, meta);
  return { records: ids.map((id) => ({ id })) };
}

export async function updateRecords(
  deps: PublicApiDeps,
  actor: Actor,
  tableId: string,
  bodyInput: unknown,
  reason?: string,
  origin?: WriteOrigin,
) {
  const body = writeBodySchema.safeParse(bodyInput);
  if (!body.success) throw new AppError("invalid_body");
  const table = await tableFor(deps, actor, tableId, "rows.write");
  const scope = await scopeFor(deps, actor, table);
  const prepared = await prepareWrites(deps, scope.engine, table, body.data);
  const meta = origin ?? { reason, source: "api" as const };
  const rows = prepared.map((record) => ({
    values: record.values,
    links: record.links.map((link) => ({
      column: link.column,
      targetIds: link.ids,
    })),
  }));
  const updates = prepared.map((record, index) => {
    const row = rows[index];
    if (!record.id || !row) throw new AppError("invalid_record_id");
    return { ...row, rowId: record.id, expected: record.expected };
  });
  await updateRows(serviceDeps(deps), scope, updates, meta);
  return { records: updates.map((update) => ({ id: update.rowId })) };
}

/** A step of a record's circuit, as the API and MCP take it. */
export const transitionBodySchema = z.object({
  transition: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,63}$/),
  reason: z.string().trim().min(1).max(500).optional(),
});

/**
 * Takes a step of the table's circuit for one record (ADR 0130), with the
 * caller's roles, as the row's panel does. A step that asks a signature
 * is taken in the application: a token proves nothing of its holder.
 */
export async function transitionRecord(
  deps: PublicApiDeps,
  actor: Actor,
  tableId: string,
  recordId: string,
  bodyInput: unknown,
  origin?: WriteOrigin,
) {
  const body = transitionBodySchema.safeParse(bodyInput);
  if (!body.success) throw new AppError("invalid_body");
  const table = await tableFor(deps, actor, tableId, "rows.transition");
  const role = effectiveTableRole(actor.bindings, table.id, table.baseId);
  if (!role) throw new AppError("access_denied");
  const scope = await scopeFor(deps, actor, table);
  const outcome = await transitionRowAs(
    serviceDeps(deps),
    { ...scope, role },
    {
      rowId: recordId,
      transitionKey: body.data.transition,
      reason: body.data.reason,
      signs: "never",
    },
    origin ?? { source: "api" },
  );
  return {
    id: recordId,
    from: outcome.from,
    to: outcome.to,
    transition: outcome.transitionKey,
  };
}

export async function deleteRecords(
  deps: PublicApiDeps,
  actor: Actor,
  tableId: string,
  ids: string[],
  reason?: string,
  origin?: WriteOrigin,
) {
  const table = await tableFor(deps, actor, tableId, "rows.delete");
  const deleted = await deleteRows(
    serviceDeps(deps),
    await scopeFor(deps, actor, table),
    ids,
    origin ?? { reason, source: "api" },
  );
  return { records: deleted.map((id) => ({ id, deleted: true })) };
}
