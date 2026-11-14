import { z } from "zod";
import { selectOptionNames } from "../field-config";
import { isRelationType, storedValueKind } from "../field-types";
import { isFilterGroup, type FilterGroup, type FilterKind } from "../filter";
import { columnNameSchema } from "../names";
import {
  findColumn,
  type EngineAccess,
  type EngineCatalog,
  type EngineColumn,
  type EngineTable,
} from "./engine";
import {
  compileColumn,
  computedDuration,
  linksJsonSql,
  type ExprContext,
  type ScalarKind,
  columnError,
} from "./expressions";
import {
  compileFilter,
  compileSearch,
  emptySql,
  refSql,
  type ColumnRef,
  type FilterContext,
} from "./filter-sql";
import { quoteIdent, SqlParams, type ParameterizedSql } from "./params";
import { dialectOf, type JsonKind, type SqlDialect } from "./dialect";
import {
  idSql,
  readTableSql,
  stableOrderSql,
  storedColumnSql,
  systemSql,
} from "./storage";
import { AppError, type ErrorCode } from "../errors";
import type { SourceLimit } from "./limits";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_READ_LIMIT = 1000;
const MAX_READ_OFFSET = 10_000_000;
export const MAX_GROUPS = 2_000;

export const rowSortSchema = z.object({
  column: columnNameSchema,
  direction: z.enum(["asc", "desc"]),
});

export type RowSort = z.infer<typeof rowSortSchema>;

export const groupSpecSchema = rowSortSchema;

type GroupSpec = RowSort;

/** System columns every read returns alongside the user columns. */
const SYSTEM_FIELDS = [
  "ag_seq",
  "ag_created_at",
  "ag_updated_at",
  "ag_created_by",
  "ag_updated_by",
] as const;

export type ReadSpec = {
  filter?: FilterGroup;
  search?: string;
  sort?: readonly RowSort[];
  groupBy?: readonly GroupSpec[];
  /** Columns to return. Defaults to every column. */
  fields?: readonly string[];
  rowIds?: readonly string[];
  /**
   * Ids to skip (ADR 0046 control-plane blank / is_not): rows without a bag
   * still match emptiness; exclusion lists those that fail the condition.
   */
  excludeRowIds?: readonly string[];
  limit: number;
  offset?: number;
  timeZone?: string;
  me?: string;
};

type ProjectedColumn = ColumnRef & {
  column: EngineColumn;
  sql: string;
  /** Set when the column could not compile, e.g. a formula that reads a deleted field. */
  error?: string;
  /** Why, as AppError tells it: its code and detail. */
  cause?: { code: ErrorCode; detail?: string };
  /** What the engine computes differently for this column (ADR 0005). */
  limits?: SourceLimit[];
  /** The message of the error a formula's value may carry (ADR 0036). */
  errorSql?: string;
  /** A lookup's or a rollup's values are durations, shown in this format. */
  duration?: string;
};

type Prepared = {
  params: SqlParams;
  d: SqlDialect;
  /** Columns of `q` that put rows in a stable order, last in every sort. */
  orderKeys: readonly string[];
  derived: string;
  columns: Map<string, ProjectedColumn>;
  filterContext: FilterContext;
  where: string;
};

/** `sql as "name"`, or `sql` alone when it already reads that column. */
function aliased(sql: string, name: string): string {
  return sql === `r."${name}"` ? sql : `${sql} as "${name}"`;
}

function kindOf(typed: { kind: string; elem?: ScalarKind }): FilterKind {
  if (typed.kind === "array") return "array";
  if (typed.kind === "null") return "text";
  return typed.kind as FilterKind;
}

function projectColumn(
  ctx: ExprContext,
  column: EngineColumn,
): ProjectedColumn {
  const table = ctx.catalog.table;
  const options =
    column.fieldType === "single_select" || column.fieldType === "multi_select"
      ? selectOptionNames(column.config)
      : undefined;
  if (isRelationType(column.fieldType)) {
    return {
      name: column.name,
      kind: "links",
      column,
      sql: linksJsonSql(ctx, table, "r", column, []),
    };
  }
  const mark = ctx.params.values.length;
  // The limits this column meets, those of the fields it reads included.
  const outer = ctx.limits;
  const limits = new Map<string, SourceLimit>();
  ctx.limits = limits;
  try {
    const typed = compileColumn(ctx, table, "r", column, []);
    const errorSql = columnError(ctx, table, "r", column);
    const duration = computedDuration(ctx, table, column);
    const base: ProjectedColumn = {
      name: column.name,
      kind:
        column.fieldType === "formula" ||
        column.fieldType === "lookup" ||
        column.fieldType === "rollup"
          ? kindOf(typed)
          : storedValueKind(column.fieldType),
      column,
      sql: typed.sql,
      options,
      ...(column.physical?.controlPlane ? { apart: true } : {}),
      ...(limits.size > 0 ? { limits: [...limits.values()] } : {}),
      ...(errorSql ? { errorSql } : {}),
      ...(duration ? { duration } : {}),
    };
    return typed.kind === "array" ? { ...base, elem: typed.elem } : base;
  } catch (error) {
    ctx.params.values.length = mark;
    return {
      name: column.name,
      kind: "text",
      column,
      sql: ctx.d.nullOf("text"),
      error: error instanceof Error ? error.message : "Invalid formula",
      ...(error instanceof AppError
        ? {
            cause: {
              code: error.code,
              ...(error.detail === undefined ? {} : { detail: error.detail }),
            },
          }
        : {}),
    };
  } finally {
    ctx.limits = outer;
    for (const [key, limit] of limits) outer?.set(key, limit);
  }
}

function assertBounds(spec: ReadSpec): void {
  if (
    !Number.isInteger(spec.limit) ||
    spec.limit < 1 ||
    spec.limit > MAX_READ_LIMIT
  ) {
    throw new AppError("invalid_limit");
  }
  const offset = spec.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_READ_OFFSET) {
    throw new AppError("invalid_offset");
  }
}

/** Every column a filter tree reads. */
function filterColumns(
  group: FilterGroup,
  into = new Set<string>(),
): Set<string> {
  for (const node of group.conditions) {
    if (isFilterGroup(node)) {
      filterColumns(node, into);
    } else {
      into.add(node.column);
    }
  }
  return into;
}

/**
 * Predicate on `alias` keeping the rows of `table` the reader may see. The
 * rule is the owner's, so it reads the real values (no field is hidden from
 * it) and only the columns it names. A rule that no longer compiles, say
 * over a deleted field, keeps no row.
 */
function rowScope(
  ctx: ExprContext,
  access: EngineAccess,
  table: EngineTable,
  alias: string,
): string | null {
  const rule = access.rowFilter(table.id);
  if (!rule) {
    return null;
  }
  const compile = (params: SqlParams, tz: () => string): string | null => {
    const privileged: ExprContext = {
      catalog: { table, tables: ctx.catalog.tables, readable: () => true },
      d: ctx.d,
      params,
      aliases: ctx.aliases,
      get tz() {
        return tz();
      },
    };
    const columns = new Map<string, ProjectedColumn>();
    for (const name of filterColumns(rule)) {
      const column = findColumn(table, name);
      if (!column) {
        throw new AppError("unknown_column", name);
      }
      const projected = projectColumn(privileged, column);
      if (projected.error) {
        // Same as a rule that no longer compiles: keep no row.
        return "false";
      }
      columns.set(name, projected);
    }
    const where = compileFilter(
      {
        params,
        d: ctx.d,
        me: access.me,
        columns,
        get tz() {
          return tz();
        },
      },
      rule,
    );
    if (!where) {
      return null;
    }
    const select = [
      aliased(idSql(table, "r"), "id"),
      ...[...columns.values()].map(
        (projected) => `${projected.sql} as ${quoteIdent(projected.name)}`,
      ),
    ];
    return `${idSql(table, alias)} in (select q."id" from (select ${select.join(", ")} from ${readTableSql(table)} r) q where ${where})`;
  };
  // A dry run on throwaway parameters: a rule that fails must not leave
  // half its bound values (or the time zone) in the statement.
  try {
    compile(new SqlParams(), () => "null::text");
  } catch {
    return "false";
  }
  return compile(ctx.params, () => ctx.tz);
}

function prepare(catalog: EngineCatalog, spec: ReadSpec): Prepared {
  const params = new SqlParams();
  let zone: string | undefined;
  const d = dialectOf(catalog.table);
  /** The time zone is bound on first use: Postgres rejects an unreferenced parameter. */
  const tz = (): string =>
    (zone ??= d.textParam(params.bind(d.zone(spec.timeZone ?? "UTC"))));
  const access = catalog.access;
  const ctx: ExprContext = {
    catalog,
    d,
    params,
    aliases: { next: 0 },
    get tz() {
      return tz();
    },
    ...(access
      ? {
          scope: (table: EngineTable, alias: string) =>
            rowScope(ctx, access, table, alias),
        }
      : {}),
  };
  const columns = new Map<string, ProjectedColumn>();
  for (const column of catalog.table.columns) {
    columns.set(column.name, projectColumn(ctx, column));
  }
  const table = catalog.table;
  // A client's rows keep their order by their key; AnyGridDB's, by the
  // place people gave them, then by when they came (`row-order.ts`).
  const stable = table.external
    ? stableOrderSql(table, "r")
    : [`r."ag_position"`];
  const select = [
    aliased(idSql(table, "r"), "id"),
    aliased(systemSql(table, "r", "ag_status"), "ag_status"),
    ...SYSTEM_FIELDS.map((field) =>
      aliased(systemSql(table, "r", field), field),
    ),
    ...stable.map((sql, index) => `${sql} as "ag_order_${String(index)}"`),
    ...[...columns.values()].map(
      (projected) => `${projected.sql} as ${quoteIdent(projected.name)}`,
    ),
    ...[...columns.values()].flatMap((projected, index) =>
      projected.errorSql
        ? [`${projected.errorSql} as ${errorColumn(index)}`]
        : [],
    ),
  ];
  // A date field whose day the dialect reads out of the stored value: its
  // filters compare that value, which the engine finds by its index.
  [...columns.values()].forEach((projected, index) => {
    const physical = projected.column.physical;
    if (
      !table.external ||
      projected.error !== undefined ||
      projected.kind !== "date" ||
      physical === undefined ||
      physical.missing ||
      physical.controlPlane ||
      !d.comparesStoredDay?.(projected.column.fieldType, physical)
    ) {
      return;
    }
    select.push(
      `${storedColumnSql(table, "r", physical.name)} as ${storedDayColumn(index)}`,
    );
    projected.stored = `q.${storedDayColumn(index)}`;
  });
  const own = ctx.scope?.(table, "r");
  const derived = `(select ${select.join(", ")} from ${readTableSql(table)} r${own ? ` where ${own}` : ""}) q`;
  const filterContext: FilterContext = {
    params,
    d,
    me: spec.me,
    columns,
    get tz() {
      return tz();
    },
  };
  // Do not object-spread `filterContext`: its `tz` getter would run now and
  // bind a time zone Postgres never sees in the SQL (42P18).
  const visible = spec.fields;
  const searchContext: FilterContext = visible
    ? {
        params: filterContext.params,
        d: filterContext.d,
        me: filterContext.me,
        columns: new Map(
          [...columns].filter(([name]) => visible.includes(name)),
        ),
        get tz() {
          return filterContext.tz;
        },
      }
    : filterContext;
  const clauses = [
    compileFilter(filterContext, spec.filter),
    compileSearch(searchContext, spec.search),
  ];
  if (spec.rowIds) {
    if (spec.rowIds.length === 0 || spec.rowIds.length > MAX_READ_LIMIT) {
      throw new AppError("invalid_limit");
    }
    // A client table's ids are text, AnyGridDB's are uuids: a text that
    // is not one names none of its rows.
    const wanted = table.external
      ? spec.rowIds
      : spec.rowIds.filter((id) => UUID.test(id));
    const list = d.textList(wanted, (value) => params.bind(value));
    clauses.push(
      table.external
        ? d.inTexts(`q."id"`, list)
        : `q."id" = any(${list}::uuid[])`,
    );
  }
  if (spec.excludeRowIds && spec.excludeRowIds.length > 0) {
    if (spec.excludeRowIds.length > MAX_READ_LIMIT) {
      throw new AppError("invalid_limit");
    }
    const skipped = table.external
      ? spec.excludeRowIds
      : spec.excludeRowIds.filter((id) => UUID.test(id));
    if (skipped.length > 0) {
      const list = d.textList(skipped, (value) => params.bind(value));
      clauses.push(
        table.external
          ? `not (${d.inTexts(`q."id"`, list)})`
          : `not (q."id" = any(${list}::uuid[]))`,
      );
    }
  }
  const present = clauses.filter((clause): clause is string => clause !== null);
  const where = present.length > 0 ? ` where ${present.join(" and ")}` : "";
  return {
    params,
    d,
    orderKeys: [
      ...stable.map((_, index) => `ag_order_${String(index)}`),
      ...(table.external ? [] : ["ag_seq"]),
    ],
    derived,
    columns,
    filterContext,
    where,
  };
}

function lookupRef(
  prepared: Prepared,
  name: string,
  purpose: "sort" | "group",
): ProjectedColumn {
  const ref = prepared.columns.get(name);
  if (!ref) {
    throw new AppError("unknown_column", name);
  }
  if (ref.kind === "files" && purpose === "group") {
    throw new AppError("invalid_group");
  }
  if (ref.column.physical?.controlPlane) {
    throw new AppError("control_plane_sort", ref.column.label);
  }
  return ref;
}

/** Scalar expression that orders rows by a column. */
function orderSql(prepared: Prepared, ref: ProjectedColumn): string {
  const x = refSql(ref.name);
  const d = prepared.d;
  const list = (items: readonly string[]) =>
    d.textList(items, (value) => prepared.params.bind(value));
  switch (ref.kind) {
    case "text":
      return ref.options
        ? d.optionPosition(x, list(ref.options))
        : d.sortText(x);
    case "boolean":
      return `(case when ${d.cond(x)} then 1 else 0 end)`;
    case "datetime":
    case "date":
    case "number":
      return x;
    case "user":
      return `${x}::text`;
    case "links":
      return d.sortText(d.firstLinkLabel(x));
    case "files":
      return d.name === "postgres"
        ? `coalesce(cardinality(${x}), 0)`
        : d.unavailable("array");
    case "options":
      if (d.name !== "postgres") return d.unavailable("array");
      return ref.options
        ? `array_position(${prepared.params.bindTextArray(ref.options)}, ${x}[1])`
        : `array_to_string(${x}, ',')`;
    default:
      return d.listSortText(x);
  }
}

function groupKeySql(prepared: Prepared, ref: ProjectedColumn): string {
  const x = refSql(ref.name);
  const d = prepared.d;
  if (ref.kind === "datetime") {
    return d.groupKey(d.localDate(x, prepared.filterContext.tz), "date");
  }
  // Keys travel as each engine's JSON: a number as a JSON number.
  return d.groupKey(x, ref.kind === "number" ? "number" : jsonKind(ref));
}

/** How a column's value travels as JSON. */
function jsonKind(ref: ProjectedColumn): JsonKind {
  switch (ref.kind) {
    case "number":
      return isExactNumber(ref) ? "text" : "number";
    case "boolean":
    case "date":
    case "datetime":
      return ref.kind;
    case "links":
    case "array":
      return "json";
    default:
      return "text";
  }
}

/**
 * Groups first, then sorts, then insertion order. Rows whose group values
 * order alike but group apart (two texts a collation calls equal, lists
 * that start alike) are told apart by their key, so each group's rows
 * follow each other and a group starts at one place only.
 */
function orderClause(
  prepared: Prepared,
  spec: Pick<ReadSpec, "groupBy" | "sort">,
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const group of spec.groupBy ?? []) {
    const ref = lookupRef(prepared, group.column, "group");
    const order = orderSql(prepared, ref);
    const key = groupKeySql(prepared, ref);
    parts.push(prepared.d.orderTerm(order, group.direction));
    // Where the key is the value itself, it already orders the rows (and
    // SQL Server refuses a term twice).
    if (key !== order) parts.push(prepared.d.groupKeyOrder(key));
    seen.add(group.column);
  }
  for (const sort of spec.sort ?? []) {
    if (seen.has(sort.column)) {
      continue;
    }
    const ref = lookupRef(prepared, sort.column, "sort");
    parts.push(prepared.d.orderTerm(orderSql(prepared, ref), sort.direction));
  }
  for (const key of prepared.orderKeys) parts.push(`q."${key}" asc`);
  return ` order by ${parts.join(", ")}`;
}

/** Aggregates whose result has the column's own precision. */
const EXACT_AGGREGATES = new Set([
  "sum",
  "avg",
  "median",
  "min",
  "max",
  "std_dev",
]);

/** Small bounded numbers stay JSON numbers; every other number is exact. */
const FLOAT_SAFE_TYPES = new Set(["rating", "duration", "autonumber"]);

function isComputed(ref: ProjectedColumn): boolean {
  const type = ref.column.fieldType;
  return type === "formula" || type === "lookup" || type === "rollup";
}

function isExactNumber(ref: ProjectedColumn): boolean {
  return ref.kind === "number" && !FLOAT_SAFE_TYPES.has(ref.column.fieldType);
}

/** The key of a row's formula errors: field name to message (ADR 0036). */
export const ROW_ERRORS = "ag_errors";

/** The message of the error a field's value is in a row, or null. */
export function rowError(
  row: Readonly<Record<string, unknown>>,
  name: string,
): string | null {
  const errors = row[ROW_ERRORS];
  if (!errors || typeof errors !== "object") return null;
  const message = (errors as Record<string, unknown>)[name];
  return typeof message === "string" ? message : null;
}

/** The column of `q` that holds the error of the `index`th column. */
function errorColumn(index: number): string {
  return `"ag_e${String(index)}"`;
}

function storedDayColumn(index: number): string {
  return `"ag_d${String(index)}"`;
}

/**
 * The errors of a page's formulas, one object per row (ADR 0036): each
 * field whose value is an error, with its message. Absent when none of
 * the fields read can carry one.
 */
function errorsEntry(
  prepared: Prepared,
  names: readonly string[],
): readonly [string, string] | undefined {
  const order = [...prepared.columns.keys()];
  const entries = names.flatMap((name) => {
    const ref = prepared.columns.get(name);
    return ref?.errorSql
      ? [
          [
            name,
            prepared.d.errorJson(`q.${errorColumn(order.indexOf(name))}`),
          ] as const,
        ]
      : [];
  });
  if (entries.length === 0) return undefined;
  return [ROW_ERRORS, prepared.d.json(prepared.d.jsonObject(entries), "json")];
}

function projection(
  prepared: Prepared,
  fields: readonly string[] | undefined,
): string {
  const names = fields ?? [...prepared.columns.keys()];
  const d = prepared.d;
  const entries: Array<readonly [string, string]> = [
    ["id", `q."id"`],
    ["ag_status", `q."ag_status"`],
  ];
  for (const field of SYSTEM_FIELDS) {
    const kind: JsonKind =
      field === "ag_seq"
        ? "number"
        : field.endsWith("_at")
          ? "datetime"
          : "text";
    entries.push([field, d.json(`q."${field}"`, kind)]);
  }
  for (const name of names) {
    const ref = prepared.columns.get(name);
    if (!ref) {
      throw new AppError("unknown_column", name);
    }
    quoteIdent(name);
    // A JSON number would round through a float in the client: exact
    // numbers travel as decimal text (ADR 0023). A stored one keeps its
    // scale; a computed one reads canonical (14.5), the same everywhere,
    // as does one AnyGridDB keeps in a side table, whose scale is its own.
    const value = isExactNumber(ref)
      ? isComputed(ref) || ref.column.physical?.side === true
        ? d.computedText(refSql(name))
        : d.exactText(refSql(name))
      : ref.kind === "array" && ref.elem === "number" && d.name === "postgres"
        ? // A list's numbers are computed: canonical, as on every engine.
          `array(select trim_scale(v)::text from unnest(${refSql(name)}) v)`
        : refSql(name);
    entries.push([name, d.json(value, jsonKind(ref))]);
  }
  const errors = errorsEntry(prepared, names);
  if (errors) entries.push(errors);
  return d.row(entries);
}

/** Page of rows, ordered by groups, then sorts, then insertion order. */
export function buildReadRows(
  catalog: EngineCatalog,
  spec: ReadSpec,
): ParameterizedSql & { columns: ProjectedColumn[] } {
  assertBounds(spec);
  const prepared = prepare(catalog, spec);
  const order = orderClause(prepared, spec);
  const page = prepared.d.limitOffset(spec.limit, spec.offset ?? 0, (value) =>
    prepared.params.bind(value),
  );
  return {
    text: `select ${projection(prepared, spec.fields)} from ${prepared.derived}${prepared.where}${order}${page}`,
    values: prepared.params.values,
    columns: [...prepared.columns.values()],
  };
}

export function buildCountRows(
  catalog: EngineCatalog,
  spec: Omit<ReadSpec, "limit">,
): ParameterizedSql {
  const prepared = prepare(catalog, { ...spec, limit: 1 });
  return {
    text: `select ${prepared.d.count("count(*)")} as "total" from ${prepared.derived}${prepared.where}`,
    values: prepared.params.values,
  };
}

/**
 * Row counts for every level of the grouping, as one grouping-sets query.
 * Each output row carries `k0…kN` (JSON keys), `depth`, and `count`. With
 * `starts`, also where the group's rows begin in the read's order
 * (`start`, from 0) and how far they reach (`span`, equal to `count` when
 * they follow each other), ordered by `start`: a grid lays its group
 * headers out from them before it reads the rows. That numbers every row
 * of the view, so only the grid's first page asks for it.
 */
export function buildGroupCounts(
  catalog: EngineCatalog,
  spec: Omit<ReadSpec, "limit">,
  options: { starts?: boolean } = {},
): ParameterizedSql | null {
  const groups = spec.groupBy ?? [];
  if (groups.length === 0) {
    return null;
  }
  // Keep in lockstep with MAX_VIEW_GROUPS in view-config.ts (avoid a cycle).
  if (groups.length > 5) {
    throw new AppError("invalid_group");
  }
  const prepared = prepare(catalog, { ...spec, limit: 1 });
  const keys: string[] = [];
  for (const [index, group] of groups.entries()) {
    const ref = lookupRef(prepared, group.column, "group");
    keys.push(`${groupKeySql(prepared, ref)} as "k${index}"`);
  }
  const starts = options.starts === true;
  if (starts) {
    keys.push(
      `row_number() over (${orderClause(prepared, spec).trim()}) as "rn"`,
    );
  }
  return {
    text: prepared.d.groupCounts({
      keys: groups.length,
      source: `select ${keys.join(", ")} from ${prepared.derived}${prepared.where}`,
      limit: MAX_GROUPS,
      starts,
      bind: (value) => prepared.params.bind(value),
    }),
    values: prepared.params.values,
  };
}

/**
 * One aggregate per group of up to two fields, computed where the rows
 * live (a chart's bars, or its series): `k0`, `k1`, and `a0` per group.
 * The median, which reads each group's rows again, is not one of them.
 */
export function buildGroupAggregates(
  catalog: EngineCatalog,
  spec: Omit<ReadSpec, "limit" | "groupBy">,
  input: {
    groups: readonly string[];
    item: AggregateItem;
    limit?: number;
  },
): ParameterizedSql {
  if (input.groups.length === 0 || input.groups.length > 2) {
    throw new AppError("invalid_group");
  }
  if (input.item.fn === "median") throw new AppError("invalid_aggregate");
  const prepared = prepare(catalog, { ...spec, limit: 1 });
  const d = prepared.d;
  const keys = input.groups.map(
    (name, index) =>
      `${groupKeySql(prepared, lookupRef(prepared, name, "group"))} as "k${String(index)}"`,
  );
  const ref = prepared.columns.get(input.item.column);
  if (!ref) throw new AppError("unknown_column", input.item.column);
  const value = aggregateSql(d, ref, input.item.fn, "");
  // A sum, mean, or extreme of exact numbers is exact too (ADR 0023).
  const exact = EXACT_AGGREGATES.has(input.item.fn) && isExactNumber(ref);
  const kind: JsonKind = exact
    ? "text"
    : (input.item.fn === "earliest" || input.item.fn === "latest") &&
        (ref.kind === "date" || ref.kind === "datetime")
      ? ref.kind
      : "number";
  return {
    text: d.groupAggregates({
      keys: input.groups.length,
      source: `select ${keys.join(", ")}, ${refSql(ref.name)} as ${quoteIdent(ref.name)} from ${prepared.derived}${prepared.where}`,
      value: exact ? d.exactText(value) : value,
      kind,
      limit: Math.min(input.limit ?? MAX_GROUPS, MAX_GROUPS),
      bind: (bound) => prepared.params.bind(bound),
    }),
    values: prepared.params.values,
  };
}

export const AGGREGATE_FNS = [
  "count_all",
  "count_empty",
  "count_filled",
  "count_unique",
  "percent_empty",
  "percent_filled",
  "percent_unique",
  "sum",
  "avg",
  "median",
  "min",
  "max",
  "std_dev",
  "earliest",
  "latest",
  "date_range_days",
  "checked",
  "unchecked",
  "percent_checked",
  "percent_unchecked",
] as const;

export type AggregateFn = (typeof AGGREGATE_FNS)[number];

const COMMON_AGGREGATES: AggregateFn[] = [
  "count_all",
  "count_empty",
  "count_filled",
  "count_unique",
  "percent_empty",
  "percent_filled",
  "percent_unique",
];

export function aggregateFunctionsFor(
  kind: FilterKind,
): readonly AggregateFn[] {
  switch (kind) {
    case "number":
      return [
        ...COMMON_AGGREGATES,
        "sum",
        "avg",
        "median",
        "min",
        "max",
        "std_dev",
      ];
    case "date":
    case "datetime":
      return [...COMMON_AGGREGATES, "earliest", "latest", "date_range_days"];
    case "boolean":
      return [
        "count_all",
        "checked",
        "unchecked",
        "percent_checked",
        "percent_unchecked",
      ];
    default:
      return COMMON_AGGREGATES;
  }
}

export const aggregateItemSchema = z.object({
  column: columnNameSchema,
  fn: z.enum(AGGREGATE_FNS),
});

export type AggregateItem = z.infer<typeof aggregateItemSchema>;

function aggregateSql(
  d: SqlDialect,
  ref: ProjectedColumn,
  fn: AggregateFn,
  /** The rows aggregated, for what needs them again (the median). */
  source: string,
): string {
  if (!aggregateFunctionsFor(ref.kind).includes(fn)) {
    throw new AppError("invalid_aggregate");
  }
  const x = refSql(ref.name);
  const empty = emptySql(ref, d);
  const unchecked = d.cond(`coalesce(${x}, ${d.boolLiteral(false)})`);
  const percent = (count: string): string =>
    `round(100.0 * (${count}) / nullif(count(*), 0), 2)`;
  // A distinct count over the filled values: PostgreSQL filters the
  // aggregate, others leave the empty ones out with a case.
  const distinctFilled =
    d.name === "postgres"
      ? `count(distinct ${x}) filter (where not ${empty})`
      : `count(distinct case when not ${empty} then ${x} end)`;
  switch (fn) {
    case "count_all":
      return "count(*)";
    case "count_empty":
      return d.countWhere(empty);
    case "count_filled":
      return d.countWhere(`not ${empty}`);
    case "count_unique":
      return distinctFilled;
    case "percent_empty":
      return percent(d.countWhere(empty));
    case "percent_filled":
      return percent(d.countWhere(`not ${empty}`));
    case "percent_unique":
      return percent(distinctFilled);
    case "sum":
      return `sum(${x})`;
    case "avg":
      return `avg(${x})`;
    case "median":
      return d.median(x, source);
    case "min":
    case "earliest":
      return `min(${x})`;
    case "max":
    case "latest":
      return `max(${x})`;
    case "std_dev":
      return d.stddev(x);
    case "date_range_days":
      return ref.kind === "date"
        ? d.daysBetween(`max(${x})`, `min(${x})`)
        : `round(${d.secondsBetween(`max(${x})`, `min(${x})`)} / 86400, 2)`;
    case "checked":
      return d.countWhere(d.cond(x));
    case "unchecked":
      return d.countWhere(`not ${unchecked}`);
    case "percent_checked":
      return percent(d.countWhere(d.cond(x)));
    case "percent_unchecked":
      return percent(d.countWhere(`not ${unchecked}`));
  }
}

/** One row with `a0…aN`, the requested aggregates over the filtered rows. */
export function buildAggregates(
  catalog: EngineCatalog,
  spec: Omit<ReadSpec, "limit">,
  items: readonly AggregateItem[],
): ParameterizedSql {
  if (items.length === 0 || items.length > 60) {
    throw new AppError("invalid_aggregate");
  }
  const prepared = prepare(catalog, { ...spec, limit: 1 });
  const d = prepared.d;
  // Each aggregate is computed in a derived table, and only its result is
  // made JSON: T-SQL evaluates `count(*)` inside FOR JSON's subquery once
  // per outer row, over that subquery's single row (always 1).
  const values = items.map(
    (item, index): { name: string; sql: string; kind: JsonKind } => {
      const ref = prepared.columns.get(item.column);
      if (!ref) {
        throw new AppError("unknown_column", item.column);
      }
      const value = aggregateSql(
        d,
        ref,
        item.fn,
        `${prepared.derived}${prepared.where}`,
      );
      const name = `a${String(index)}`;
      // A sum, mean, or extreme of exact numbers is exact too (ADR 0023).
      if (EXACT_AGGREGATES.has(item.fn) && isExactNumber(ref)) {
        return { name, sql: d.exactText(value), kind: "text" };
      }
      const kind: JsonKind =
        (item.fn === "earliest" || item.fn === "latest") &&
        (ref.kind === "date" || ref.kind === "datetime")
          ? ref.kind
          : "number";
      return { name, sql: value, kind };
    },
  );
  const inner = values
    .map((value) => `${value.sql} as "${value.name}"`)
    .join(", ");
  const entries = values.map((value): readonly [string, string] => [
    value.name,
    d.json(`a."${value.name}"`, value.kind),
  ]);
  return {
    text: `select ${d.row(entries)} from (select ${inner} from ${prepared.derived}${prepared.where}) a`,
    values: prepared.params.values,
  };
}

/** Kind of each column as reads see it, for clients choosing operators and renderers. */
export function describeColumns(catalog: EngineCatalog): Array<{
  name: string;
  kind: FilterKind;
  elem?: ScalarKind;
  error?: string;
  cause?: { code: ErrorCode; detail?: string };
  limits?: SourceLimit[];
  duration?: string;
}> {
  const prepared = prepare(catalog, { limit: 1 });
  return [...prepared.columns.values()].map((ref) => ({
    name: ref.name,
    kind: ref.kind,
    ...(ref.elem ? { elem: ref.elem } : {}),
    ...(ref.error ? { error: ref.error } : {}),
    ...(ref.cause ? { cause: ref.cause } : {}),
    ...(ref.limits ? { limits: ref.limits } : {}),
    ...(ref.duration ? { duration: ref.duration } : {}),
  }));
}
