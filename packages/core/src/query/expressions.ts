import { ceilingOf } from "../limits";
import { rollupFitsTarget, type RollupFn } from "../field-config";
import {
  SYSTEM_COLUMN,
  isComputedType,
  isRelationType,
  isSystemType,
  storedValueKind,
  type ValueKind,
} from "../field-types";
import { FIELD_SQL, formulaExprOf, rollupFnOf } from "./field-sql";
import {
  FORMULA_FN_SPECS,
  formulaChildren,
  type FormulaExpr,
  type FormulaFn,
} from "../formula";
import {
  findColumn,
  type EngineCatalog,
  type EngineColumn,
  type EngineRelation,
  type EngineTable,
} from "./engine";
import {
  columnSql,
  idSql,
  keySql,
  stableOrderSql,
  storedColumnSql,
  storeOf,
  systemSql,
  readTableSql,
} from "./storage";
import {
  POSTGRES,
  serverAtLeast,
  type DatePart,
  type SqlDialect,
  type TimeUnit,
} from "./dialect";
import { isIsoDate } from "../iso-date";
import { parseJsonPath } from "./json-path";
import { compileFilter, type ColumnRef } from "./filter-sql";
import { isFilterGroup, type FilterGroup, type FilterKind } from "../filter";
import { portableRegex, regexReplacement } from "./regex";
import { numberToDecimal } from "../decimal";
import { parseIsoInstant } from "./iso-instant";
import {
  limitKey,
  limitOf,
  precisionLimit,
  regexLimit,
  type SourceLimit,
} from "./limits";
import {
  BIGINT_DIGITS,
  columnDigits,
  exactDividend,
  INT_DIGITS,
  literalDigits,
  mayOverflow,
  productDigits,
  quotientDigits,
  sumDigits,
  unionDigits,
  UNKNOWN_DIGITS,
  type Digits,
} from "./digits";

export { toCharPattern } from "./dialect";
import { SqlParams, quoteExternalIdent, quoteIdent } from "./params";
import { AppError } from "../errors";

/** Scalar result kinds of a compiled expression. */
export type ScalarKind = "number" | "text" | "boolean" | "date" | "datetime";

/** A compiled SQL expression with its static type. `null` is BLANK(). */
export type Typed =
  | {
      sql: string;
      kind: ScalarKind;
      /** A number's T-SQL type, where the compiler followed it (`digits.ts`). */
      digits?: Digits;
      /**
       * A number known to be small: a literal, a blank, or a cell of
       * AnyGridDB's own, which holds 60 digits at most. A product takes it
       * as it is (`withinReach`).
       */
      small?: true;
      /** A text the formula writes out, read as a date when it compiles. */
      literal?: string;
    }
  | {
      sql: string;
      kind: "array";
      elem: ScalarKind;
      /**
       * The values as text joined by `, `, built where the list is: an
       * engine without arrays (MySQL) cannot join its JSON list safely.
       */
      joined?: string;
    }
  | { sql: string; kind: "null" };

export type ExprContext = {
  catalog: EngineCatalog;
  /** The engine the query runs on (ADR 0005). */
  d: SqlDialect;
  params: SqlParams;
  /** Bound time-zone placeholder, e.g. `$3::text`. */
  tz: string;
  aliases: { next: number };
  /**
   * Predicate on `alias` that keeps the rows of `table` the reader may see,
   * or null for every row. Set by the read builder when the catalog carries
   * access rules.
   */
  scope?: (table: EngineTable, alias: string) => string | null;
  /**
   * Predicate on `alias` that keeps the rows of `table` on which the reader
   * sees `column`, or null for every row they read (ADR 0144). Set beside
   * `scope`.
   */
  shown?: (
    table: EngineTable,
    column: EngineColumn,
    alias: string,
  ) => string | null;
  /**
   * What the engine computes differently from AnyGridDB's semantics, met
   * while compiling: the field shows it (ADR 0005).
   */
  limits?: Map<string, SourceLimit>;
};

/** Records that `operation` runs under the engine's limit, if it has one. */
function noteLimit(ctx: ExprContext, operation: string): void {
  const limit = limitOf(ctx.d.name, operation);
  if (limit) ctx.limits?.set(limitKey(limit), limit);
}

/** Records that the engine may round this number (SQL Server's 38 digits). */
function notePrecision(ctx: ExprContext): void {
  const limit = precisionLimit(ctx.d.name);
  ctx.limits?.set(limitKey(limit), limit);
}

/** ` and <predicate>` restricting a linked table to the reader's rows. */
function scopeAnd(ctx: ExprContext, table: EngineTable, alias: string): string {
  const predicate = ctx.scope?.(table, alias);
  return predicate ? ` and ${predicate}` : "";
}

function isHidden(
  ctx: ExprContext,
  table: EngineTable,
  column: EngineColumn,
): boolean {
  return ctx.catalog.access?.hidden(table.id, column.name) ?? false;
}

/** The empty value of the same kind, for a field the reader may not see. */
function blank(typed: Typed, d: SqlDialect): Typed {
  switch (typed.kind) {
    case "array":
      return emptyArray(typed.elem, d);
    case "null":
      return typed;
    default:
      return nullOf(typed.kind, d);
  }
}

const MAX_STACK = 16;

const ARRAY_SQL_TYPE: Record<ScalarKind, string> = {
  number: "numeric[]",
  text: "text[]",
  boolean: "boolean[]",
  date: "date[]",
  datetime: "timestamptz[]",
};

function nextAlias(ctx: ExprContext): string {
  ctx.aliases.next += 1;
  return `t${ctx.aliases.next}`;
}

function col(alias: string, name: string): string {
  return `${alias}.${quoteIdent(name)}`;
}

function emptyArray(elem: ScalarKind, d: SqlDialect = POSTGRES): Typed {
  return {
    sql:
      d.name === "postgres"
        ? `array[]::${ARRAY_SQL_TYPE[elem]}`
        : d.emptyList(elem),
    kind: "array",
    elem,
  };
}

/** A value as a list: a list as it is, another value as a list of one. */
function asList(
  ctx: ExprContext,
  typed: Typed,
): Extract<Typed, { kind: "array" }> {
  if (typed.kind === "array") return typed;
  if (typed.kind === "null") {
    return emptyArray("text", ctx.d) as Extract<Typed, { kind: "array" }>;
  }
  return {
    sql: ctx.d.listOne(typed.sql, typed.kind),
    kind: "array",
    elem: typed.kind,
  };
}

function nullOf(kind: ScalarKind, d: SqlDialect = POSTGRES): Typed {
  // A blank number is the narrowest decimal: it widens nothing it meets.
  return kind === "number"
    ? { sql: d.nullOf(kind), kind, digits: { p: 1, s: 0 }, small: true }
    : { sql: d.nullOf(kind), kind };
}

/* ------------------------------------------------------------------ */
/* Coercions                                                           */
/* ------------------------------------------------------------------ */

function asText(ctx: ExprContext, typed: Typed): string {
  switch (typed.kind) {
    case "text":
      return typed.sql;
    case "number":
      return ctx.d.numberText(typed.sql);
    case "boolean":
      return `(case when ${ctx.d.cond(typed.sql)} then 'true' when not ${ctx.d.cond(typed.sql)} then 'false' end)`;
    case "date":
      return ctx.d.dateText(typed.sql);
    case "datetime":
      return ctx.d.localDatetimeText(typed.sql, ctx.tz);
    case "array":
      return typed.joined ?? listText(ctx, typed, "', '");
    case "null":
      return ctx.d.nullOf("text");
  }
}

/**
 * A list's values as text joined by `separator`, each written as `asText`
 * writes it, the same on every engine: an instant in the reader's zone.
 */
function listText(
  ctx: ExprContext,
  list: Extract<Typed, { kind: "array" }>,
  separator: string,
): string {
  const d = ctx.d;
  const alias = nextAlias(ctx);
  const value = `${alias}.v`;
  const text =
    d.name === "postgres"
      ? asText(ctx, { sql: value, kind: list.elem })
      : list.elem === "datetime"
        ? d.localDatetimeText(d.listInstant(value), ctx.tz)
        : value;
  return d.listJoin(list.sql, alias, text, separator);
}

function asNumber(ctx: ExprContext, typed: Typed): string {
  switch (typed.kind) {
    case "number":
      return typed.sql;
    case "text":
      return ctx.d.textToNumber(typed.sql);
    case "boolean": {
      const condition = ctx.d.cond(typed.sql);
      return ctx.d.name === "postgres"
        ? `(case when ${condition} then 1::numeric when not ${condition} then 0::numeric end)`
        : `(case when ${condition} then 1 when not ${condition} then 0 end)`;
    }
    case "array":
      return typed.elem === "number"
        ? ctx.d.listSum(typed.sql)
        : ctx.d.nullOf("number");
    default:
      return ctx.d.nullOf("number");
  }
}

/**
 * Whether a value is there: not blank, and for a text or a list not empty.
 * A zero and a false are values, which `asBool` reads as false.
 */
function asFilled(typed: Typed, d: SqlDialect): string {
  switch (typed.kind) {
    case "text":
    case "array":
    case "null":
      return asBool(typed, d);
    default:
      return `(${typed.sql} is not null)`;
  }
}

/** A value as a condition, never unknown: a blank is false. */
function asBool(typed: Typed, d: SqlDialect = POSTGRES): string {
  switch (typed.kind) {
    case "boolean":
      return d.cond(`coalesce(${typed.sql}, ${d.boolLiteral(false)})`);
    case "number":
      return d.truth(`${typed.sql} <> 0`);
    case "text":
      return d.truth(d.textFilled(typed.sql));
    case "array":
      return d.truth(`${d.listLength(typed.sql)} > 0`);
    case "null":
      return "(1 = 0)";
    default:
      return `(${typed.sql} is not null)`;
  }
}

function asDate(ctx: ExprContext, typed: Typed): string {
  switch (typed.kind) {
    case "date":
      return typed.sql;
    case "datetime":
      return ctx.d.localDate(typed.sql, ctx.tz);
    case "text":
      return ctx.d.localDate(textInstant(ctx, typed), ctx.tz);
    default:
      return ctx.d.nullOf("date");
  }
}

function asDatetime(ctx: ExprContext, typed: Typed): string {
  switch (typed.kind) {
    case "datetime":
      return typed.sql;
    case "date":
      return ctx.d.dateToInstant(typed.sql, ctx.tz);
    case "text":
      return textInstant(ctx, typed);
    default:
      return ctx.d.nullOf("datetime");
  }
}

/**
 * Text as an instant. A date the formula writes out is read now, by the
 * same grammar: the engine then only places it in the reader's zone.
 */
function textInstant(ctx: ExprContext, typed: Typed): string {
  if (typed.kind !== "text" || typed.literal === undefined) {
    return ctx.d.textToInstant(typed.sql, ctx.tz);
  }
  // MySQL's DATETIME starts in the year 1000.
  const minYear = ctx.d.name === "mysql" || ctx.d.name === "mariadb" ? 1000 : 1;
  const instant = parseIsoInstant(typed.literal, minYear);
  const value = instant
    ? ctx.d.dateToInstant(
        ctx.d.textParam(ctx.params.bind(instant.timestamp)),
        instant.utc ? `'${ctx.d.zone("UTC")}'` : ctx.tz,
      )
    : ctx.d.nullOf("datetime");
  // The text stays bound: PostgreSQL refuses a parameter nothing reads.
  return `(case when ${typed.sql} is null then null else ${value} end)`;
}

/** Common kind of several branches (IF, SWITCH): equal kinds stay, else text. */
function unify(ctx: ExprContext, branches: readonly Typed[]): Typed[] {
  const concrete = branches.filter((branch) => branch.kind !== "null");
  const first = concrete[0];
  if (!first) {
    return [...branches];
  }
  const same = concrete.every(
    (branch) =>
      branch.kind === first.kind &&
      (branch.kind !== "array" ||
        (first.kind === "array" && branch.elem === first.elem)),
  );
  if (same) {
    return branches.map((branch) =>
      branch.kind === "null"
        ? first.kind === "array"
          ? emptyArray(first.elem, ctx.d)
          : nullOf(first.kind, ctx.d)
        : branch,
    );
  }
  return branches.map((branch) => ({
    sql: asText(ctx, branch),
    kind: "text" as const,
  }));
}

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

/** FROM and WHERE that list the rows a link column points to. */
function linkSource(
  relation: EngineRelation,
  own: EngineTable,
  ownAlias: string,
  target: EngineTable,
  alias: string,
): { from: string; where: string } {
  const targetTable = `${readTableSql(target)} ${alias}`;
  if (relation.kind === "one_to_many") {
    if (!relation.fkColumn) {
      throw new AppError("invalid_relation");
    }
    return relation.direction === "forward"
      ? {
          from: targetTable,
          where: `${keySql(target, alias)} = ${storedColumnSql(own, ownAlias, relation.fkColumn)}`,
        }
      : {
          from: targetTable,
          where: `${storedColumnSql(target, alias, relation.fkColumn)} = ${keySql(own, ownAlias)}`,
        };
  }
  // Junction tables hold AnyGridDB's own many-to-many links only.
  if (!relation.junction || own.external || target.external) {
    throw new AppError("invalid_relation");
  }
  const junction = `${alias}j`;
  const near = relation.direction === "forward" ? "left_id" : "right_id";
  const far = relation.direction === "forward" ? "right_id" : "left_id";
  return {
    from: `${quoteIdent(relation.junction)} ${junction} join ${targetTable} on ${alias}."id" = ${junction}."${far}"`,
    where: `${junction}."${near}" = ${ownAlias}."id"`,
  };
}

function linkedTable(
  ctx: ExprContext,
  column: EngineColumn,
): EngineTable | undefined {
  const relation = column.relation;
  if (!relation) {
    return undefined;
  }
  if (!ctx.catalog.readable(relation.targetTableId)) {
    return undefined;
  }
  const target = ctx.catalog.tables.get(relation.targetTableId);
  // One query joins one database: a link to a table read elsewhere (another
  // source, a copy in AnyGridDB, ADR 0034) reads empty.
  if (!target || storeOf(target) !== storeOf(ctx.catalog.table)) {
    return undefined;
  }
  return target;
}

/** Text that labels a row of `table`: its primary column, else its id. */
function labelSql(
  ctx: ExprContext,
  table: EngineTable,
  alias: string,
  stack: readonly string[],
): string {
  const primary = table.primaryColumn
    ? findColumn(table, table.primaryColumn)
    : undefined;
  if (
    !primary ||
    isRelationType(primary.fieldType) ||
    stack.length >= MAX_STACK
  ) {
    return ctx.d.keyText(idSql(table, alias));
  }
  const typed = compileColumn(ctx, table, alias, primary, stack);
  return `coalesce(${asText(ctx, typed)}, '')`;
}

/** Link cell as JSON: `[{"id": …, "label": …}]`, in row order. */
export function linksJsonSql(
  ctx: ExprContext,
  table: EngineTable,
  alias: string,
  column: EngineColumn,
  stack: readonly string[],
): string {
  const target = linkedTable(ctx, column);
  if (!target || !column.relation || isHidden(ctx, table, column)) {
    return ctx.d.emptyLinks();
  }
  const inner = nextAlias(ctx);
  const source = linkSource(column.relation, table, alias, target, inner);
  const label = labelSql(ctx, target, inner, [
    ...stack,
    `${table.id}:${column.name}`,
  ]);
  const links = ctx.d.linksAgg({
    id: idSql(target, inner),
    label,
    from: source.from,
    where: `${source.where}${scopeAnd(ctx, target, inner)}`,
    order: stableOrderSql(target, inner),
  });
  const shown = ctx.shown?.(table, column, alias);
  return shown
    ? `(case when ${shown} then ${links} else ${ctx.d.emptyLinks()} end)`
    : links;
}

/* ------------------------------------------------------------------ */
/* Columns                                                             */
/* ------------------------------------------------------------------ */

function storedTyped(
  ctx: ExprContext,
  alias: string,
  column: EngineColumn,
  kind: ValueKind,
): Typed {
  // A client column may be stored under another name than its own.
  const ref = isSystemType(column.fieldType)
    ? col(alias, SYSTEM_COLUMN[column.fieldType])
    : columnSql(alias, column, ctx.d);
  switch (kind) {
    case "text":
    case "number":
    case "boolean":
    case "date":
    case "datetime":
      return kind === "number" && ctx.d.name === "sqlserver" && column.physical
        ? { sql: ref, kind, digits: columnDigits(column.physical.type) }
        : {
            // The row's number is a bigint: read as any number is.
            sql:
              kind === "number" && isSystemType(column.fieldType)
                ? `${ref}::numeric`
                : ref,
            kind,
            // A client's column holds what its engine lets it.
            ...(kind === "number" && !column.physical ? { small: true } : {}),
          };
    case "user":
      return { sql: `${ref}::text`, kind: "text" };
    case "users":
      return { sql: `${ref}::text[]`, kind: "array", elem: "text" };
    case "options":
    case "files":
      return { sql: ref, kind: "array", elem: "text" };
    case "links":
      throw new AppError("invalid_relation");
  }
}

/**
 * A column's value as a typed SQL expression over `alias`. A field the
 * reader may not see keeps its kind but compiles to empty, so nothing that
 * reads it (a formula, a lookup, a filter, a sort) can reveal its values.
 */
export function compileColumn(
  ctx: ExprContext,
  table: EngineTable,
  alias: string,
  column: EngineColumn,
  stack: readonly string[],
): Typed {
  if (!isHidden(ctx, table, column)) {
    return onlyWhereShown(
      ctx,
      table,
      alias,
      column,
      compileVisibleColumn(ctx, table, alias, column, stack),
    );
  }
  return blank(
    compileVisibleColumn(sandboxOf(ctx), table, alias, column, stack),
    ctx.d,
  );
}

/**
 * A field's value on the rows where the reader sees it, and empty of the
 * same kind on the others (ADR 0144): a filter, a sort, a search, a
 * formula or a lookup that reads it reads the empty value there.
 */
function onlyWhereShown(
  ctx: ExprContext,
  table: EngineTable,
  alias: string,
  column: EngineColumn,
  typed: Typed,
): Typed {
  const shown = ctx.shown?.(table, column, alias);
  if (!shown || typed.kind === "null") return typed;
  const empty = blank(typed, ctx.d);
  return {
    ...typed,
    sql: `(case when ${shown} then ${typed.sql} else ${empty.sql} end)`,
  };
}

/**
 * A context to compile something only for its kind, against throwaway
 * parameters: none of its SQL or bound values reach the statement.
 */
function sandboxOf(ctx: ExprContext): ExprContext {
  return {
    catalog: ctx.catalog,
    d: ctx.d,
    params: new SqlParams(),
    tz: "null::text",
    aliases: { next: ctx.aliases.next },
  };
}

/**
 * A rollup that reads values the reader may not see: blank, not a total
 * of nothing. Only the count of linked rows reads none of them.
 */
function rollupOfHidden(
  ctx: ExprContext,
  table: EngineTable,
  column: EngineColumn,
): boolean {
  const fn = rollupFnOf(column);
  if (!fn || fn === "count") return false;
  const relation = column.config.relation
    ? findColumn(table, column.config.relation)
    : undefined;
  const target = relation ? linkedTable(ctx, relation) : undefined;
  const targetColumn =
    target && column.config.target
      ? findColumn(target, column.config.target)
      : undefined;
  return target && targetColumn ? isHidden(ctx, target, targetColumn) : false;
}

function compileVisibleColumn(
  ctx: ExprContext,
  table: EngineTable,
  alias: string,
  column: EngineColumn,
  stack: readonly string[],
): Typed {
  const key = `${table.id}:${column.name}`;
  if (stack.includes(key)) {
    throw new AppError("circular_formula");
  }
  // Past the deepest chain it follows, a field says so: blank, it read as
  // a result, and a save kept a formula that computed nothing.
  if (stack.length >= MAX_STACK) {
    throw new AppError("formula_too_large");
  }
  // Read by a formula, a lookup, or a rollup: a field kept in AnyGridDB's
  // database is not in the query the engine runs (ADR 0046).
  if (stack.length > 0 && column.physical?.controlPlane) {
    throw new AppError("control_plane_formula", column.label);
  }
  const next = [...stack, key];
  const read = FIELD_SQL[column.fieldType].read;
  switch (read) {
    case "formula": {
      const expr = column.config.expr;
      if (!expr) {
        throw new AppError("invalid_formula");
      }
      return compileFormula(ctx, table, alias, expr, next);
    }
    case "lookup":
    case "rollup":
      return rollupOfHidden(ctx, table, column)
        ? blank(
            compileComputed(sandboxOf(ctx), table, alias, column, next),
            ctx.d,
          )
        : compileComputed(ctx, table, alias, column, next);
    case "none":
      // A button holds no value: it acts on the row when clicked.
      return nullOf("text", ctx.d);
    case "row_id":
      // The id the API, webhooks and links name the row by: AnyGridDB's
      // uuid, or a client table's key (ADR 0063).
      // A client table's id is text already.
      return {
        sql: table.external
          ? idSql(table, alias)
          : ctx.d.keyText(idSql(table, alias)),
        kind: "text",
      };
    case "links": {
      const target = linkedTable(ctx, column);
      if (!target || !column.relation) {
        return emptyArray("text", ctx.d);
      }
      const inner = nextAlias(ctx);
      const source = linkSource(column.relation, table, alias, target, inner);
      const label = labelSql(ctx, target, inner, next);
      const rows = {
        element: label,
        from: source.from,
        where: `${source.where}${scopeAnd(ctx, target, inner)}`,
        order: stableOrderSql(target, inner),
      };
      return {
        sql: ctx.d.listAgg({ ...rows, kind: "text" }),
        kind: "array",
        elem: "text",
        ...(ctx.d.name === "postgres"
          ? {}
          : { joined: ctx.d.joinAgg({ ...rows, separator: "', '" }) }),
      };
    }
    case "stored":
      if (isComputedType(column.fieldType)) {
        throw new AppError("internal_error", "computed field stored");
      }
      return storedTyped(ctx, alias, column, storedValueKind(column.fieldType));
  }
}

/* ------------------------------------------------------------------ */
/* Lookups and rollups                                                 */
/* ------------------------------------------------------------------ */

/** A spread of the values: of a sample, or of the whole population. */
function spread(
  d: SqlDialect,
  fn: "std_dev" | "variance" | "std_dev_pop" | "variance_pop",
  number: string,
): string {
  switch (fn) {
    case "std_dev":
      return d.stddev(number);
    case "variance":
      return d.variance(number);
    case "std_dev_pop":
      return d.stddevPop(number);
    case "variance_pop":
      return d.variancePop(number);
  }
}

/** Rollups whose result is in the values' own unit: a sum of hours is hours. */
const UNIT_KEEPING = new Set<RollupFn>([
  "sum",
  "avg",
  "sum_distinct",
  "avg_distinct",
  "min",
  "max",
  "std_dev",
  "std_dev_pop",
]);

/**
 * The duration format a lookup or a rollup shows its values in: its
 * target's, when the target is a duration and the function keeps the
 * unit. A variance is in squared seconds: a number.
 */
export function computedDuration(
  ctx: ExprContext,
  table: EngineTable,
  column: EngineColumn,
  depth = 0,
): string | undefined {
  const read = FIELD_SQL[column.fieldType].read;
  if (read !== "lookup" && read !== "rollup") return undefined;
  const fn = rollupFnOf(column);
  if (read === "rollup" && (!fn || !UNIT_KEEPING.has(fn))) {
    return undefined;
  }
  const relation = column.config.relation
    ? findColumn(table, column.config.relation)
    : undefined;
  const target = relation ? linkedTable(ctx, relation) : undefined;
  const targetColumn =
    target && column.config.target
      ? findColumn(target, column.config.target)
      : undefined;
  if (!target || !targetColumn) return undefined;
  if (FIELD_SQL[targetColumn.fieldType].seconds) {
    return targetColumn.config.durationFormat ?? "h:mm";
  }
  return depth < 4
    ? computedDuration(ctx, target, targetColumn, depth + 1)
    : undefined;
}

function rollupKind(fn: RollupFn, target: Typed): Typed["kind"] {
  switch (fn) {
    case "count":
    case "counta":
    case "count_unique":
    case "sum":
    case "avg":
    case "sum_distinct":
    case "avg_distinct":
    case "std_dev":
    case "variance":
    case "std_dev_pop":
    case "variance_pop":
      return "number";
    case "and":
    case "or":
      return "boolean";
    case "concatenate":
      return "text";
    case "array_unique":
      return "array";
    case "earliest":
    case "latest":
      return target.kind === "datetime" ? "datetime" : "date";
    case "min":
    case "max":
      return target.kind === "array" || target.kind === "null"
        ? "number"
        : target.kind;
  }
}

function compileComputed(
  ctx: ExprContext,
  table: EngineTable,
  alias: string,
  column: EngineColumn,
  stack: readonly string[],
): Typed {
  const relationName = column.config.relation;
  const targetName = column.config.target;
  const relationColumn = relationName
    ? findColumn(table, relationName)
    : undefined;
  const fn = rollupFnOf(column);
  const lookup = FIELD_SQL[column.fieldType].read === "lookup";
  const target = relationColumn ? linkedTable(ctx, relationColumn) : undefined;
  const targetColumn =
    target && targetName ? findColumn(target, targetName) : undefined;
  if (!relationColumn?.relation || !target || !targetColumn) {
    if (lookup) return emptyArray("text", ctx.d);
    return nullOf(fn === "concatenate" ? "text" : "number", ctx.d);
  }
  // Its target may have changed type since: a sum over words is no sum.
  if (fn && !rollupFitsTarget(fn, targetColumn.fieldType)) {
    throw new AppError("invalid_formula");
  }
  const inner = nextAlias(ctx);
  const source = linkSource(
    relationColumn.relation,
    table,
    alias,
    target,
    inner,
  );
  const value = compileColumn(ctx, target, inner, targetColumn, stack);
  // Only the linked rows its condition keeps, besides the reader's.
  const kept = `${scopeAnd(ctx, target, inner)}${linkedFilterAnd(ctx, target, inner, column.config.filter, stack)}`;
  if (ctx.d.name !== "postgres") {
    return computedWithoutArrays(ctx, fn, value, {
      from: source.from,
      where: `${source.where}${kept}`,
      order: stableOrderSql(target, inner),
    });
  }
  const order = `order by ${stableOrderSql(target, inner).join(", ")}`;
  const scope = `from ${source.from} where ${source.where}${kept}`;
  if (lookup || !fn) {
    if (value.kind === "array") {
      return {
        sql: `array(select v ${scope.replace(" where ", ` cross join unnest(${value.sql}) v where `)} ${order})`,
        kind: "array",
        elem: value.elem,
      };
    }
    const elem: ScalarKind = value.kind === "null" ? "text" : value.kind;
    return {
      sql: `array(select ${value.kind === "null" ? "null::text" : value.sql} ${scope} ${order})`,
      kind: "array",
      elem,
    };
  }
  const kind = rollupKind(fn, value);
  const flat =
    value.kind === "array"
      ? {
          sql: "v",
          kind: value.elem,
          from: scope.replace(
            " where ",
            ` cross join unnest(${value.sql}) v where `,
          ),
        }
      : { sql: value.sql, kind: value.kind, from: scope };
  const flatTyped: Typed =
    flat.kind === "null"
      ? { sql: "null", kind: "null" }
      : { sql: flat.sql, kind: flat.kind };
  switch (fn) {
    case "count":
      return { sql: `(select count(*)::numeric ${scope})`, kind: "number" };
    case "counta":
      return {
        sql: `(select count(*)::numeric ${flat.from} and ${asFilled(flatTyped, ctx.d)})`,
        kind: "number",
      };
    case "count_unique":
      return {
        sql: `(select count(distinct ${flat.sql})::numeric ${flat.from})`,
        kind: "number",
      };
    case "sum":
      // A sum of nothing is 0, as a count is: a total, not a blank.
      return {
        sql: `(select coalesce(sum(${asNumber(ctx, flatTyped)}), 0) ${flat.from})`,
        kind: "number",
      };
    case "avg": {
      // A mean divides as `/` does: 20 decimals on every engine.
      const number = asNumber(ctx, flatTyped);
      return {
        sql: `(select ${ctx.d.divide(`sum(${number})`, `count(${number})`)} ${flat.from})`,
        kind: "number",
      };
    }
    case "sum_distinct":
      return {
        sql: `(select coalesce(sum(distinct ${asNumber(ctx, flatTyped)}), 0) ${flat.from})`,
        kind: "number",
      };
    case "avg_distinct": {
      const number = asNumber(ctx, flatTyped);
      return {
        sql: `(select ${ctx.d.divide(`sum(distinct ${number})`, `count(distinct ${number})`)} ${flat.from})`,
        kind: "number",
      };
    }
    case "std_dev":
    case "variance":
    case "std_dev_pop":
    case "variance_pop": {
      // Rounded to 20 decimals, as a quotient is.
      const value = spread(ctx.d, fn, asNumber(ctx, flatTyped));
      return {
        sql: `(select round(${value}, 20) ${flat.from})`,
        kind: "number",
      };
    }
    case "min":
    case "max": {
      // Text by code point, the same on every engine.
      const scalar =
        kind === "number"
          ? asNumber(ctx, flatTyped)
          : kind === "text"
            ? ctx.d.exactTextKey(flat.sql)
            : flat.sql;
      return {
        sql: `(select ${fn}(${scalar}) ${flat.from})`,
        kind: kind === "array" || kind === "null" ? "number" : kind,
      };
    }
    case "earliest":
    case "latest": {
      const scalar =
        kind === "datetime"
          ? asDatetime(ctx, flatTyped)
          : asDate(ctx, flatTyped);
      return {
        sql: `(select ${fn === "earliest" ? "min" : "max"}(${scalar}) ${flat.from})`,
        kind: kind === "datetime" ? "datetime" : "date",
      };
    }
    case "and":
      return {
        sql: `(select bool_and(${asBool(flatTyped, ctx.d)}) ${flat.from})`,
        kind: "boolean",
      };
    case "or":
      return {
        sql: `(select bool_or(${asBool(flatTyped, ctx.d)}) ${flat.from})`,
        kind: "boolean",
      };
    case "concatenate":
      return {
        sql: `(select string_agg(${asText(ctx, flatTyped)}, ', ' ${order}) ${flat.from})`,
        kind: "text",
      };
    case "array_unique": {
      const elem: ScalarKind =
        flatTyped.kind === "null" ? "text" : flatTyped.kind;
      return {
        sql: `array(select distinct ${flatTyped.kind === "null" ? "null::text" : flat.sql} ${flat.from})`,
        kind: "array",
        elem,
      };
    }
  }
}

/**
 * A lookup or a rollup on an engine without arrays (MySQL, MariaDB): a
 * lookup is an ordered JSON list, with its text joined beside it; a rollup
 * aggregates the linked rows directly. A list of lists is refused there.
 */
function computedWithoutArrays(
  ctx: ExprContext,
  fn: RollupFn | undefined,
  value: Typed,
  rows: { from: string; where: string; order: readonly string[] },
): Typed {
  const d = ctx.d;
  if (value.kind === "array") {
    // A list of lists reads flat: each linked row's values in turn.
    const item = nextAlias(ctx);
    return computedWithoutArrays(
      ctx,
      fn,
      { sql: d.listValue(`${item}.v`, value.elem), kind: value.elem },
      {
        from: `${rows.from} ${d.listItemsJoin(value.sql, item)}`,
        where: rows.where,
        order: [...rows.order, `${item}.i`],
      },
    );
  }
  const scope = `from ${rows.from} where ${rows.where}`;
  const joined = (element: string) =>
    d.joinAgg({ ...rows, element, separator: "', '" });
  if (!fn) {
    const elem: ScalarKind = value.kind === "null" ? "text" : value.kind;
    const element = value.kind === "null" ? "null" : value.sql;
    return {
      sql: d.listAgg({ ...rows, element, kind: elem }),
      kind: "array",
      elem,
      joined: joined(asText(ctx, value)),
    };
  }
  const { sql: number, digits } = sized(ctx, value);
  const kind = rollupKind(fn, value);
  // A count is an int on every engine.
  const counted = (sql: string): Typed => ({
    sql,
    kind: "number",
    digits: INT_DIGITS,
  });
  switch (fn) {
    case "count":
      return counted(`(select count(*) ${scope})`);
    case "counta":
      return counted(`(select count(*) ${scope} and ${asFilled(value, d)})`);
    case "count_unique":
      return counted(
        `(select count(distinct ${value.kind === "text" ? d.exactTextKey(value.sql) : value.sql}) ${scope})`,
      );
    case "sum": {
      if (d.name !== "sqlserver") {
        return {
          sql: `(select coalesce(sum(${number}), 0) ${scope})`,
          kind: "number",
        };
      }
      // T-SQL types a sum decimal(38, s): fewer than a billion rows need
      // nine digits more than one value.
      const total = { p: Math.min(38, digits.p + 9), s: digits.s };
      if (digits.p + 9 > 38) notePrecision(ctx);
      return {
        sql: `(select cast(coalesce(sum(${number}), 0) as decimal(${String(total.p)},${String(total.s)})) ${scope})`,
        kind: "number",
        digits: total,
      };
    }
    case "sum_distinct": {
      if (d.name !== "sqlserver") {
        return {
          sql: `(select coalesce(sum(distinct ${number}), 0) ${scope})`,
          kind: "number",
        };
      }
      const total = { p: Math.min(38, digits.p + 9), s: digits.s };
      if (digits.p + 9 > 38) notePrecision(ctx);
      return {
        sql: `(select cast(coalesce(sum(distinct ${number}), 0) as decimal(${String(total.p)},${String(total.s)})) ${scope})`,
        kind: "number",
        digits: total,
      };
    }
    case "avg_distinct": {
      const [sum, count] = [
        `sum(distinct ${number})`,
        `count(distinct ${number})`,
      ];
      if (d.name !== "sqlserver") {
        return {
          sql: `(select ${d.divide(sum, count)} ${scope})`,
          kind: "number",
        };
      }
      const mean =
        sqlServerMean(sum, count, digits) ??
        sqlServerQuotient(
          { sql: sum, digits: { p: 38, s: digits.s } },
          { sql: count, digits: INT_DIGITS },
        );
      return computed(ctx, { ...mean, sql: `(select ${mean.sql} ${scope})` });
    }
    case "std_dev":
    case "variance":
    case "std_dev_pop":
    case "variance_pop": {
      // Floating point on these engines: the field says so (ADR 0027).
      noteLimit(ctx, fn);
      const value = spread(d, fn, number);
      return {
        sql: `(select ${d.fromFloat(value)} ${scope})`,
        kind: "number",
        ...(d.name === "sqlserver" ? { digits: UNKNOWN_DIGITS } : {}),
      };
    }
    case "avg": {
      if (d.name !== "sqlserver") {
        return {
          sql: `(select ${d.divide(`sum(${number})`, `count(${number})`)} ${scope})`,
          kind: "number",
        };
      }
      const [sum, count] = [`sum(${number})`, `count(${number})`];
      const mean =
        sqlServerMean(sum, count, digits) ??
        sqlServerQuotient(
          { sql: sum, digits: { p: 38, s: digits.s } },
          { sql: count, digits: INT_DIGITS },
        );
      return computed(ctx, { ...mean, sql: `(select ${mean.sql} ${scope})` });
    }
    case "min":
    case "max": {
      const scalar =
        kind === "number"
          ? number
          : kind === "text"
            ? d.exactTextKey(value.sql)
            : value.sql;
      const result: ScalarKind =
        kind === "array" || kind === "null" ? "number" : kind;
      const sql = `(select ${fn}(${scalar}) ${scope})`;
      return result === "number"
        ? { sql, kind: result, digits }
        : { sql, kind: result };
    }
    case "earliest":
    case "latest": {
      const scalar =
        kind === "datetime" ? asDatetime(ctx, value) : asDate(ctx, value);
      return {
        sql: `(select ${fn === "earliest" ? "min" : "max"}(${scalar}) ${scope})`,
        kind: kind === "datetime" ? "datetime" : "date",
      };
    }
    case "and":
    case "or":
      // Booleans as 0 and 1: every one true is a minimum of 1.
      return {
        sql: d.bitOf(
          `(select ${fn === "and" ? "min" : "max"}(case when ${asBool(value, d)} then 1 else 0 end) ${scope})`,
        ),
        kind: "boolean",
      };
    case "concatenate":
      return { sql: joined(asText(ctx, value)), kind: "text" };
    case "array_unique": {
      const elem: ScalarKind = value.kind === "null" ? "text" : value.kind;
      const element = value.kind === "null" ? "null" : value.sql;
      return {
        sql: d.listUnique(d.listAgg({ ...rows, element, kind: elem }), elem),
        kind: "array",
        elem,
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Formulas                                                            */
/* ------------------------------------------------------------------ */

const UNIT_SECONDS: Record<string, number> = {
  second: 1,
  seconds: 1,
  minute: 60,
  minutes: 60,
  hour: 3600,
  hours: 3600,
  day: 86400,
  days: 86400,
  week: 604800,
  weeks: 604800,
};

const DATE_PARTS = [
  "year",
  "month",
  "week",
  "day",
  "hour",
  "minute",
  "second",
] as const;

function literalString(
  expr: FormulaExpr | undefined,
  fallback: string,
): string {
  if (!expr) {
    return fallback;
  }
  if (expr.op !== "str") {
    throw new AppError("invalid_formula");
  }
  return expr.value.trim().toLowerCase();
}

const SHORT_UNITS: Readonly<Record<string, TimeUnit>> = {
  y: "year",
  m: "month",
  w: "week",
  d: "day",
  h: "hour",
  min: "minute",
  mi: "minute",
  s: "second",
  sec: "second",
};

/** A unit by its name or its abbreviation, as written. */
function unitNamed(unit: string): TimeUnit | undefined {
  return (DATE_PARTS as readonly string[]).includes(unit)
    ? (unit as TimeUnit)
    : SHORT_UNITS[unit];
}

/**
 * The unit a formula names. A name and an abbreviation of several letters
 * take a plural (`months`, `mins`); a single letter does not, so that `ms`
 * is no month: there is no millisecond among the units.
 */
function normalizeUnit(raw: string): TimeUnit {
  const singular =
    raw.length > 2 && raw.endsWith("s") ? raw.slice(0, -1) : undefined;
  const value = unitNamed(raw) ?? (singular ? unitNamed(singular) : undefined);
  if (!value) {
    throw new AppError("invalid_unit");
  }
  return value;
}

function compileArgs(
  ctx: ExprContext,
  table: EngineTable,
  alias: string,
  args: readonly FormulaExpr[],
  stack: readonly string[],
): Typed[] {
  return args.map((arg) => compileFormula(ctx, table, alias, arg, stack));
}

/** Collects numeric arguments, scalars and number arrays alike, as one numeric[] expression. */
function numericArray(ctx: ExprContext, args: readonly Typed[]): string {
  const parts = args.map((arg) =>
    arg.kind === "array"
      ? arg.elem === "number"
        ? arg.sql
        : `array(select ${asNumber(ctx, { sql: "v", kind: arg.elem })} from unnest(${arg.sql}) v)`
      : `array[${asNumber(ctx, arg)}]::numeric[]`,
  );
  return parts.length === 1
    ? (parts[0] ?? "array[]::numeric[]")
    : `(${parts.join(" || ")})`;
}

function textArray(ctx: ExprContext, args: readonly Typed[]): string {
  const parts = args.map((arg) =>
    arg.kind === "array"
      ? `array(select ${asText(ctx, { sql: "v", kind: arg.elem })} from unnest(${arg.sql}) v)`
      : `array[${asText(ctx, arg)}]::text[]`,
  );
  return parts.length === 1
    ? (parts[0] ?? "array[]::text[]")
    : `(${parts.join(" || ")})`;
}

/**
 * SUM, AVERAGE, and COUNT of separate values on engines without arrays:
 * blanks are left out, as an aggregate leaves them out.
 */
function scalarAggregate(
  ctx: ExprContext,
  fn: "sum" | "average" | "count",
  args: readonly Typed[],
): Typed {
  if (ctx.d.name === "sqlserver") return sqlServerAggregate(ctx, fn, args);
  const d = ctx.d;
  // A list counts each of its numbers, and adds them.
  const parts = args.map((arg) => {
    if (arg.kind !== "array") {
      const value = asNumber(ctx, arg);
      return {
        count: `(case when ${value} is null then 0 else 1 end)`,
        sum: `coalesce(${value}, 0)`,
      };
    }
    if (arg.elem !== "number") return { count: "0", sum: "0" };
    return {
      count: `coalesce(${d.listAggregate(arg.sql, "count", "number")}, 0)`,
      sum: `coalesce(${d.listAggregate(arg.sql, "sum", "number")}, 0)`,
    };
  });
  const count = `(${parts.map((part) => part.count).join(" + ")})`;
  const sum = `(case when ${count} = 0 then null else ${parts.map((part) => part.sum).join(" + ")} end)`;
  if (fn === "count") return { sql: count, kind: "number" };
  return {
    sql: fn === "sum" ? sum : ctx.d.divide(sum, count),
    kind: "number",
  };
}

/**
 * Several values as one column `y.v`, a list's values among them: a
 * derived table T-SQL types as their union.
 */
function sqlServerValues(
  ctx: ExprContext,
  args: readonly Typed[],
  kind: "number" | "date",
): { rows: string; digits: Digits[] } {
  const selects: string[] = [];
  const digits: Digits[] = [];
  for (const arg of args) {
    if (arg.kind === "array") {
      const item = nextAlias(ctx);
      selects.push(
        `select ${ctx.d.listValue(`${item}.v`, kind)} as v from (select [value] as v from openjson(${arg.sql})) ${item}`,
      );
      digits.push(UNKNOWN_DIGITS);
    } else if (kind === "date") {
      selects.push(`select ${asDate(ctx, arg)} as v`);
    } else {
      const value = sized(ctx, arg);
      selects.push(`select ${value.sql} as v`);
      digits.push(value.digits);
    }
  }
  return { rows: `(${selects.join(" union all ")}) y`, digits };
}

/** The same on SQL Server, over the values as one column. */
function sqlServerAggregate(
  ctx: ExprContext,
  fn: "sum" | "average" | "count",
  args: readonly Typed[],
): Typed {
  const { rows, digits: values } = sqlServerValues(ctx, args, "number");
  const union = unionDigits(values);
  if (!union.exact) notePrecision(ctx);
  if (fn === "count") {
    return {
      sql: `(select count(v) from ${rows})`,
      kind: "number",
      digits: INT_DIGITS,
    };
  }
  if (fn === "sum") {
    // n values hold at most n times the widest: a few digits more.
    // A list may hold many values: its sum is as wide as T-SQL allows.
    const p = args.some((arg) => arg.kind === "array")
      ? 38
      : Math.min(38, union.digits.p + String(values.length).length);
    const digits = { p, s: union.digits.s };
    return {
      sql: `(select cast(sum(v) as decimal(${String(p)},${String(digits.s)})) from ${rows})`,
      kind: "number",
      digits,
    };
  }
  const mean =
    sqlServerMean("sum(v)", "count(v)", union.digits) ??
    sqlServerQuotient(
      { sql: "sum(v)", digits: { p: 38, s: union.digits.s } },
      { sql: "count(v)", digits: INT_DIGITS },
    );
  return computed(ctx, { ...mean, sql: `(select ${mean.sql} from ${rows})` });
}

/**
 * ROUND, ROUNDDOWN, and ROUNDUP on SQL Server's decimals. ROUND gets one
 * more digit first: 9.95 rounds to 10.0, which decimal(3,2) cannot hold,
 * and T-SQL would fail the read. ROUNDUP adds a step of 10^-digits, exact:
 * written out when the digits are a number in the formula.
 */
function sqlServerRound(
  ctx: ExprContext,
  fn: "round" | "roundup" | "rounddown",
  x: Sized,
  digits: string,
  written: FormulaExpr | undefined,
): Typed {
  if (fn === "rounddown") {
    return {
      sql: `round(${x.sql}, ${digits}, 1)`,
      kind: "number",
      digits: x.digits,
    };
  }
  if (fn === "round") {
    const wider = { p: Math.min(38, x.digits.p + 1), s: x.digits.s };
    return {
      sql: `round(cast(${x.sql} as decimal(${String(wider.p)},${String(wider.s)})), ${digits})`,
      kind: "number",
      digits: wider,
    };
  }
  const step = roundingStep(written, digits);
  const cut = `round(${x.sql}, ${digits}, 1)`;
  const result = sumDigits(x.digits, step.digits);
  return computed(ctx, {
    sql: `(case when ${cut} = ${x.sql} then ${x.sql} when ${x.sql} < 0 then ${cut} - ${step.sql} else ${cut} + ${step.sql} end)`,
    ...result,
  });
}

/** 10 to the power -digits, as an exact decimal. */
function roundingStep(written: FormulaExpr | undefined, digits: string): Sized {
  const value =
    written === undefined
      ? 0
      : written.op === "num"
        ? written.value
        : written.op === "neg" && written.arg.op === "num"
          ? -written.arg.value
          : undefined;
  if (value !== undefined) {
    const places = Math.max(-20, Math.min(20, Math.round(value)));
    const text =
      places > 0 ? `0.${"0".repeat(places - 1)}1` : `1${"0".repeat(-places)}`;
    const size = literalDigits(text);
    return {
      sql: `cast(${text} as decimal(${String(size.p)},${String(size.s)}))`,
      digits: size,
    };
  }
  return {
    sql: `try_convert(decimal(38,18), case when ${digits} > 0 then concat('0.', replicate('0', ${digits} - 1), '1') else concat('1', replicate('0', -${digits})) end)`,
    digits: UNKNOWN_DIGITS,
  };
}

/** MIN and MAX of separate values, blanks left out. */
/** A text the formula writes out that is a day: `"2024-06-01"`. */
function writtenDay(typed: Typed): boolean {
  return (
    typed.kind === "text" &&
    typed.literal !== undefined &&
    isIsoDate(typed.literal.trim())
  );
}

/** A text the formula writes out that names a day or an instant. */
function writtenInstant(typed: Typed): boolean {
  return (
    typed.kind === "text" &&
    typed.literal !== undefined &&
    parseIsoInstant(typed.literal, 1) !== null
  );
}

/**
 * What the smallest and the largest of these values is: a day when each is
 * one, an instant when days, instants and the texts that write them meet,
 * and otherwise a number, as it always was.
 */
function datedAs(args: readonly Typed[]): "date" | "datetime" | undefined {
  if (
    args.every(
      (arg) =>
        arg.kind === "date" ||
        (arg.kind === "array" && arg.elem === "date") ||
        writtenDay(arg),
    )
  ) {
    return "date";
  }
  return args.every(
    (arg) =>
      arg.kind === "date" || arg.kind === "datetime" || writtenInstant(arg),
  )
    ? "datetime"
    : undefined;
}

/** The earliest or the latest of days and instants, as an instant. */
function instantExtreme(
  ctx: ExprContext,
  fn: "min" | "max",
  args: readonly Typed[],
): Typed {
  const values = args.map((arg) => asDatetime(ctx, arg));
  if (ctx.d.name === "sqlserver") {
    // No LEAST or GREATEST before SQL Server 2022: one column of values.
    const rows = values.map((value) => `select ${value} as v`);
    return {
      sql: `(select ${fn}(y.v) from (${rows.join(" union all ")}) y)`,
      kind: "datetime",
    };
  }
  const pick = fn === "min" ? "least" : "greatest";
  const sql = nestNullableExtreme(values, pick);
  return { sql, kind: "datetime" };
}

function scalarExtreme(
  ctx: ExprContext,
  fn: "min" | "max",
  args: readonly Typed[],
): Typed {
  const timed = datedAs(args);
  if (timed === "datetime") return instantExtreme(ctx, fn, args);
  const dated = timed === "date";
  const kind = dated ? "date" : "number";
  if (ctx.d.name === "sqlserver") {
    // No LEAST or GREATEST before SQL Server 2022: one column of values.
    const { rows, digits } = sqlServerValues(ctx, args, kind);
    const sql = `(select ${fn}(y.v) from ${rows})`;
    if (dated) return { sql, kind: "date" };
    const union = unionDigits(digits);
    if (!union.exact) notePrecision(ctx);
    return { sql, kind: "number", digits: union.digits };
  }
  // A list stands for its own extreme.
  const values = args.map((arg) =>
    arg.kind === "array"
      ? arg.elem === kind
        ? ctx.d.listAggregate(arg.sql, fn, kind)
        : ctx.d.nullOf(kind)
      : dated
        ? asDate(ctx, arg)
        : asNumber(ctx, arg),
  );
  // LEAST and GREATEST are null when one value is: skip the blanks.
  const pick = fn === "min" ? "least" : "greatest";
  const sql = nestNullableExtreme(values, pick);
  return { sql, kind };
}

/**
 * Fold values with null-skipping LEAST/GREATEST. An empty list is not a
 * formula argument list the typer admits; the first value seeds the fold.
 */
function nestNullableExtreme(
  values: readonly string[],
  pick: "least" | "greatest",
): string {
  const [first, ...rest] = values;
  if (first === undefined) throw new AppError("invalid_arguments");
  return rest.reduce(
    (acc, value) =>
      `(case when ${acc} is null then ${value} when ${value} is null then ${acc} else ${pick}(${acc}, ${value}) end)`,
    first,
  );
}

/** The longest text REPT writes; past it, its cell carries an error. */
const MAX_REPT_TEXT = ceilingOf("formula.repeat_chars");

/** One past the limit, so that a count too large is still seen as one. */
function reptCount(ctx: ExprContext, sql: string): string {
  return clampInt(ctx, sql, 0, MAX_REPT_TEXT + 1);
}

function clampInt(
  ctx: ExprContext,
  sql: string,
  low: number,
  high: number,
): string {
  return ctx.d.toInt(ctx.d.clamp(sql, low, high));
}

function compare(
  ctx: ExprContext,
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte",
  left: Typed,
  right: Typed,
  /** One side is a large object, which its engine compares its own way. */
  large = false,
): string {
  const symbol = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[
    op
  ];
  const kinds = new Set([left.kind, right.kind]);
  if (kinds.has("null")) {
    const other = left.kind === "null" ? right : left;
    if (op === "eq") {
      return `(not ${asBool(other, ctx.d)})`;
    }
    if (op === "neq") {
      return asBool(other, ctx.d);
    }
    return ctx.d.cond(ctx.d.nullOf("boolean"));
  }
  if (left.kind === "number" && right.kind === "number") {
    return `(${left.sql} ${symbol} ${right.sql})`;
  }
  if (
    (left.kind === "date" || left.kind === "datetime") &&
    (right.kind === "date" || right.kind === "datetime")
  ) {
    if (left.kind === "date" && right.kind === "date") {
      return `(${left.sql} ${symbol} ${right.sql})`;
    }
    return `(${asDatetime(ctx, left)} ${symbol} ${asDatetime(ctx, right)})`;
  }
  if (left.kind === "boolean" && right.kind === "boolean") {
    return `(${left.sql} ${symbol} ${right.sql})`;
  }
  if (
    (left.kind === "number" && right.kind === "text") ||
    (left.kind === "text" && right.kind === "number")
  ) {
    return `(${asNumber(ctx, left)} ${symbol} ${asNumber(ctx, right)})`;
  }
  // Text compares by code point: the same result on every engine.
  const [a, b] = [asText(ctx, left), asText(ctx, right)];
  return large && ctx.d.compareLarge
    ? ctx.d.compareLarge(a, symbol, b)
    : ctx.d.compareText(a, symbol, b);
}

function dateFunction(ctx: ExprContext, part: DatePart, arg: Typed): Typed {
  if (arg.kind !== "date" && arg.kind !== "datetime" && arg.kind !== "text") {
    return nullOf("number", ctx.d);
  }
  return {
    sql: ctx.d.datePart(part, wallClock(ctx, arg)),
    kind: "number",
    digits: part === "second" ? { p: 9, s: 7 } : INT_DIGITS,
  };
}

/** A date, or an instant in the reader's zone, as a wall-clock timestamp. */
function wallClock(ctx: ExprContext, typed: Typed): string {
  return typed.kind === "date"
    ? ctx.d.dateTimestamp(typed.sql)
    : ctx.d.localTimestamp(asDatetime(ctx, typed), ctx.tz);
}

/** Whole units from `right` to `left`, truncated: DATETIME_DIFF. */
function dateDiff(
  ctx: ExprContext,
  left: Typed,
  right: Typed,
  unit: TimeUnit,
): Typed {
  const d = ctx.d;
  const number = (sql: string, digits?: Digits): Typed =>
    digits ? { sql, kind: "number", digits } : { sql, kind: "number" };
  if (unit === "month" || unit === "year") {
    const months = d.monthsBetween(
      asDatetime(ctx, left),
      asDatetime(ctx, right),
    );
    if (d.name !== "postgres") {
      return number(
        unit === "month" ? months : d.truncate(`${months} / 12`, "0"),
        INT_DIGITS,
      );
    }
    return number(
      unit === "month"
        ? `${months}::numeric`
        : `trunc(${months} / 12)::numeric`,
    );
  }
  if (left.kind === "date" && right.kind === "date" && unit === "day") {
    const days = d.daysBetween(left.sql, right.sql);
    return number(
      d.name === "postgres" ? `${days}::numeric` : days,
      INT_DIGITS,
    );
  }
  const seconds = UNIT_SECONDS[unit] ?? 86400;
  const elapsed = d.secondsBetween(
    asDatetime(ctx, left),
    asDatetime(ctx, right),
  );
  return d.name === "postgres"
    ? number(`trunc(${elapsed} / ${String(seconds)})::numeric`)
    : wholeNumber(ctx, d.truncate(`${elapsed} / ${String(seconds)}`, "0"));
}

/* ------------------------------------------------------------------ */
/* Conditions on linked rows                                           */
/* ------------------------------------------------------------------ */

function filterColumns(group: FilterGroup): string[] {
  return group.conditions.flatMap((node) =>
    isFilterGroup(node) ? filterColumns(node) : [node.column],
  );
}

/**
 * ` and <condition>` on the linked rows a lookup or rollup reads, `alias`
 * the linked table: its fields compile there, as the filter reads them, a
 * formula or a lookup of theirs included.
 */
function linkedFilterAnd(
  ctx: ExprContext,
  target: EngineTable,
  alias: string,
  filter: FilterGroup | undefined,
  stack: readonly string[],
): string {
  if (!filter || filter.conditions.length === 0) return "";
  const columns = new Map<string, ColumnRef>();
  for (const name of new Set(filterColumns(filter))) {
    const column = findColumn(target, name);
    if (!column) throw new AppError("unknown_column", name);
    const typed = compileColumn(ctx, target, alias, column, stack);
    // As the page reads a field's kind (`read.ts`).
    const kind: FilterKind = isRelationType(column.fieldType)
      ? "links"
      : isComputedType(column.fieldType)
        ? typed.kind === "array"
          ? "array"
          : typed.kind === "null"
            ? "text"
            : typed.kind
        : storedValueKind(column.fieldType);
    columns.set(name, {
      name,
      kind,
      expression: typed.sql,
      ...(typed.kind === "array" ? { elem: typed.elem } : {}),
    });
  }
  const condition = compileFilter(
    {
      params: ctx.params,
      d: ctx.d,
      columns,
      get tz() {
        return ctx.tz;
      },
    },
    filter,
  );
  return condition ? ` and ${condition}` : "";
}

/* ------------------------------------------------------------------ */
/* Errors (ADR 0036)                                                   */
/* ------------------------------------------------------------------ */

/** The parts a chain of `&` joins, in order. */
function joinedParts(expr: FormulaExpr): FormulaExpr[] {
  return expr.op === "concat"
    ? [...joinedParts(expr.left), ...joinedParts(expr.right)]
    : [expr];
}

/** Whether `expr` joins texts: `&`, or CONCAT. */
function joins(expr: FormulaExpr): boolean {
  return expr.op === "concat" || (expr.op === "call" && expr.fn === "concat");
}

/**
 * The engine's test that texts, joined, are too long for its text, when
 * this read guards its joins (`EngineCatalog.guardedJoins`).
 */
function joinGuard(
  ctx: ExprContext,
): ((parts: readonly string[]) => string) | undefined {
  return ctx.catalog.guardedJoins ? ctx.d.joinTooLong?.bind(ctx.d) : undefined;
}

/**
 * Texts joined end to end. In a read that guards its joins, one too long
 * for the engine's text is blank on its row, and `formulaError` says why.
 * A large object has no such bound: joined, it stays one.
 */
function joinOf(
  ctx: ExprContext,
  parts: readonly string[],
  large: boolean,
): string {
  const sql = ctx.d.concatAll(parts);
  const tooLong = joinGuard(ctx);
  return tooLong && !large && parts.length > 1
    ? `(case when not ${tooLong(parts)} then ${sql} end)`
    : sql;
}

/**
 * Whether an error can be reached from `expr`, through the formulas it
 * reads. A join is one where the read guards them.
 */
function canFail(
  guarded: boolean,
  table: EngineTable,
  expr: FormulaExpr,
  seen: Set<string> = new Set(),
): boolean {
  if (expr.op === "call" && (expr.fn === "error" || expr.fn === "rept")) {
    return true;
  }
  if (guarded && joins(expr)) return true;
  if (expr.op === "call" && expr.fn === "is_error") return false;
  if (expr.op === "col") {
    const column = findColumn(table, expr.name);
    const key = `${table.id}:${expr.name}`;
    const inner = column ? formulaExprOf(column) : undefined;
    if (!inner || seen.has(key)) return false;
    seen.add(key);
    return canFail(guarded, table, inner, seen);
  }
  return formulaChildren(expr).some((child) =>
    canFail(guarded, table, child, seen),
  );
}

/**
 * The message of the error `expr` carries, as text SQL: ERROR's, passed
 * on by whatever reads it, until IS_ERROR. A condition passes on the
 * error of the branch it takes. Undefined when no error can arise, which
 * costs nothing. A field the reader may not see carries none.
 */
function formulaError(
  ctx: ExprContext,
  table: EngineTable,
  alias: string,
  expr: FormulaExpr,
  stack: readonly string[],
): string | undefined {
  const joinTooLong = joinGuard(ctx);
  if (!canFail(joinTooLong !== undefined, table, expr)) return undefined;
  const d = ctx.d;
  const of = (node: FormulaExpr) =>
    formulaError(ctx, table, alias, node, stack);
  const first = (errors: ReadonlyArray<string | undefined>) => {
    const present = errors.filter(
      (error): error is string => error !== undefined,
    );
    if (present.length === 0) return undefined;
    return present.length === 1
      ? present[0]
      : `coalesce(${present.join(", ")})`;
  };
  const choose = (
    condition: FormulaExpr,
    then: FormulaExpr,
    otherwise: FormulaExpr | undefined,
  ) => {
    const [yes, no] = [of(then), otherwise ? of(otherwise) : undefined];
    const taken =
      yes === undefined && no === undefined
        ? undefined
        : `(case when ${asBool(compileFormula(ctx, table, alias, condition, stack), d)} then ${yes ?? d.nullOf("text")} else ${no ?? d.nullOf("text")} end)`;
    return first([of(condition), taken]);
  };
  // The join these parts make, where the engine would raise on its size.
  const tooLong = (parts: readonly FormulaExpr[]) =>
    joinTooLong &&
    parts.length > 1 &&
    !parts.some((part) => givesLargeObject(ctx, table, part, stack))
      ? `(case when ${joinTooLong(
          parts.map((part) =>
            asText(ctx, compileFormula(ctx, table, alias, part, stack)),
          ),
        )} then ${d.errorMessage("'Text too long'")} end)`
      : undefined;
  switch (expr.op) {
    case "col": {
      const column = findColumn(table, expr.name);
      const inner = column ? formulaExprOf(column) : undefined;
      if (!column || !inner || isHidden(ctx, table, column)) return undefined;
      const key = `${table.id}:${column.name}`;
      if (stack.includes(key)) throw new AppError("circular_formula");
      return errorWhereShown(
        ctx,
        table,
        alias,
        column,
        formulaError(ctx, table, alias, inner, [...stack, key]),
      );
    }
    case "if":
      return choose(expr.cond, expr.then, expr.else);
    case "call":
      switch (expr.fn) {
        case "error": {
          const [message] = expr.args;
          return d.errorMessage(
            message
              ? asText(ctx, compileFormula(ctx, table, alias, message, stack))
              : undefined,
          );
        }
        case "is_error":
          return undefined;
        case "rept": {
          const [value, times] = expr.args;
          if (!value || !times) return undefined;
          const repeated = asText(
            ctx,
            compileFormula(ctx, table, alias, value, stack),
          );
          const count = reptCount(
            ctx,
            asNumber(ctx, compileFormula(ctx, table, alias, times, stack)),
          );
          return first([
            of(value),
            of(times),
            `(case when ${d.textLength(repeated)} * ${count} > ${String(MAX_REPT_TEXT)} then ${d.errorMessage("'Text too long'")} end)`,
          ]);
        }
        case "if": {
          const [condition, then, otherwise] = expr.args;
          if (!condition || !then) return undefined;
          return choose(condition, then, otherwise);
        }
        case "switch": {
          // The subject's error, then the one of the result taken.
          const [subject, ...rest] = expr.args;
          if (!subject) return undefined;
          const value = compileFormula(ctx, table, alias, subject, stack);
          const pairs: string[] = [];
          for (let index = 0; index + 1 < rest.length; index += 2) {
            const match = rest[index];
            const result = rest[index + 1];
            if (!match || !result) continue;
            const error = of(result);
            pairs.push(
              `when ${compare(ctx, "eq", value, compileFormula(ctx, table, alias, match, stack), comparesLarge(ctx, table, [subject, match], stack))} then ${error ?? d.nullOf("text")}`,
            );
          }
          const fallback =
            rest.length % 2 === 1
              ? of(rest[rest.length - 1] as FormulaExpr)
              : undefined;
          return first([
            of(subject),
            // The values compared, not the default (the last one, alone).
            ...rest
              .slice(0, rest.length - (rest.length % 2))
              .filter((_, index) => index % 2 === 0)
              .map(of),
            `(case ${pairs.join(" ")} else ${fallback ?? d.nullOf("text")} end)`,
          ]);
        }
        case "concat":
          return first([...expr.args.map(of), tooLong(expr.args)]);
        default:
          return first(expr.args.map(of));
      }
    case "concat": {
      const parts = joinedParts(expr);
      return first([...parts.map(of), tooLong(parts)]);
    }
    default:
      return first(formulaChildren(expr).map(of));
  }
}

/** Functions whose text is made from a text they are given. */
const PASS_TEXT_ON: ReadonlySet<FormulaFn> = new Set<FormulaFn>([
  "concat",
  "lower",
  "upper",
  "trim",
  "left",
  "right",
  "mid",
  "substitute",
  "replace",
  "rept",
  "t",
  "text_before",
  "text_after",
  "regex_extract",
  "regex_replace",
  "encode_url_component",
]);

/**
 * Whether a formula's text can be a large object of its engine, which that
 * engine neither sorts nor compares: one it reads and passes on. A number,
 * a date or a flag made from one is not, whatever it read to get there.
 */
export function givesLargeObject(
  ctx: ExprContext,
  table: EngineTable,
  expr: FormulaExpr,
  stack: readonly string[],
): boolean {
  if (!ctx.d.holdsLargeObject) return false;
  const passedOn = (node: FormulaExpr) =>
    givesLargeObject(ctx, table, node, stack);
  switch (expr.op) {
    case "col": {
      const column = findColumn(table, expr.name);
      if (!column) return false;
      const { physical } = column;
      if (physical && !physical.side && !physical.controlPlane) {
        return ctx.d.holdsLargeObject(physical);
      }
      const inner = formulaExprOf(column);
      const key = `${table.id}:${column.name}`;
      if (!inner || stack.includes(key)) return false;
      return givesLargeObject(ctx, table, inner, [...stack, key]);
    }
    case "concat":
      return passedOn(expr.left) || passedOn(expr.right);
    case "if":
      return passedOn(expr.then) || passedOn(expr.else);
    case "call":
      if (expr.fn === "if") return expr.args.slice(1).some(passedOn);
      // What SWITCH compares is not what it gives: its results are.
      if (expr.fn === "switch") {
        return expr.args
          .slice(1)
          .some(
            (node, index, rest) =>
              (index % 2 === 1 || index === rest.length - 1) && passedOn(node),
          );
      }
      return PASS_TEXT_ON.has(expr.fn) && expr.args.some(passedOn);
    default:
      return false;
  }
}

/** Whether a comparison of these reads a large object of its engine. */
function comparesLarge(
  ctx: ExprContext,
  table: EngineTable,
  nodes: ReadonlyArray<FormulaExpr | undefined>,
  stack: readonly string[],
): boolean {
  return (
    ctx.d.compareLarge !== undefined &&
    nodes.some(
      (node) => node !== undefined && givesLargeObject(ctx, table, node, stack),
    )
  );
}

/**
 * The branches of a CASE, which takes one type: where one is a large
 * object, a short text beside it is made one too.
 */
function largeBranches(
  ctx: ExprContext,
  table: EngineTable,
  nodes: ReadonlyArray<FormulaExpr | undefined>,
  stack: readonly string[],
  branches: readonly Typed[],
): Typed[] {
  if (
    !ctx.d.largeText ||
    !nodes.some(
      (node) => node !== undefined && givesLargeObject(ctx, table, node, stack),
    )
  ) {
    return [...branches];
  }
  return branches.map((branch) =>
    branch.kind === "text"
      ? { ...branch, sql: ctx.d.largeText?.(branch.sql) ?? branch.sql }
      : branch,
  );
}

/** The error a formula column's values may carry; undefined for others. */
export function columnError(
  ctx: ExprContext,
  table: EngineTable,
  alias: string,
  column: EngineColumn,
): string | undefined {
  if (isHidden(ctx, table, column)) return undefined;
  const { physical } = column;
  if (
    table.external &&
    physical &&
    !physical.side &&
    !physical.controlPlane &&
    !physical.missing
  ) {
    return errorWhereShown(
      ctx,
      table,
      alias,
      column,
      ctx.d.storedError?.(
        `${alias}.${quoteExternalIdent(physical.name)}`,
        physical,
        column.fieldType,
      ),
    );
  }
  const expr = formulaExprOf(column);
  if (!expr) return undefined;
  return errorWhereShown(
    ctx,
    table,
    alias,
    column,
    formulaError(ctx, table, alias, expr, [`${table.id}:${column.name}`]),
  );
}

/** A field's error on the rows where the reader sees it, none on the others. */
function errorWhereShown(
  ctx: ExprContext,
  table: EngineTable,
  alias: string,
  column: EngineColumn,
  error: string | undefined,
): string | undefined {
  const shown = error ? ctx.shown?.(table, column, alias) : null;
  return error && shown ? `(case when ${shown} then ${error} end)` : error;
}

/* ------------------------------------------------------------------ */
/* Working days                                                        */
/* ------------------------------------------------------------------ */

/** A date's weekday as an integer: Monday 0 to Sunday 6. */
function weekdayIndex(d: SqlDialect, date: string): string {
  return d.mod(`(${d.toInt(d.datePart("dow", date))} + 6)`, "7");
}

/**
 * The date `days` working days after `start` (before it when negative),
 * Saturdays and Sundays skipped, `start` itself not counted: in closed
 * form, from the Monday of its week. A weekend start counts from the
 * Friday before going forward, and from the Monday after going back.
 * Zero days is `start`, a weekend included.
 */
function workdaySql(d: SqlDialect, start: string, days: string): string {
  const [s, n] = ["wd.s", "wd.n"];
  const w = weekdayIndex(d, s);
  const weekend = `${w} >= 5`;
  const from = `(case when ${weekend} then (case when ${n} > 0 then 4 else 0 end) else ${w} end)`;
  const monday = `(case when ${weekend} and ${n} < 0 then ${d.addDays(s, `7 - ${w}`)} else ${d.addDays(s, `-${w}`)} end)`;
  const total = `(${n} + ${from})`;
  const weeks = d.toInt(`floor(${total} / 5.0)`);
  // Each value is named once: inlined, they would repeat beyond what SQL
  // Server compiles.
  const row = d.boundRow(
    [
      { name: "s", sql: start, type: "date" },
      { name: "n", sql: days, type: "int" },
    ],
    "wd",
  );
  return `(select case when ${n} = 0 then ${s} else ${d.addDays(monday, `${total} + 2 * ${weeks}`)} end from ${row})`;
}

/** Working days from `a` to `b`, both counted, `a` not after `b`. */
function workdayCount(d: SqlDialect, a: string, b: string): string {
  const days = `(${d.daysBetween("wc.b", "wc.a")} + 1)`;
  const w = weekdayIndex(d, "wc.a");
  const weeks = d.toInt(`floor(${days} / 7.0)`);
  const rest = `(${days} - 7 * ${weeks})`;
  const head = `(case when ${w} >= 5 then 0 when ${w} + ${rest} >= 5 then 5 - ${w} else ${rest} end)`;
  const tail = `(case when ${w} + ${rest} > 7 then ${w} + ${rest} - 7 else 0 end)`;
  const row = d.boundRow(
    [
      { name: "a", sql: a, type: "date" },
      { name: "b", sql: b, type: "date" },
    ],
    "wc",
  );
  return `(select 5 * ${weeks} + ${head} + ${tail} from ${row})`;
}

/** Holidays: a list of dates and how a value of it reads as a date. */
type Holidays = { list: string; day: (alias: string) => string };

/**
 * The holidays a WORKDAY call names: dates written in the formula
 * (`"2026-01-01, 2026-05-01"`), or a list or a value it reads, such as a
 * lookup of a date field. Each date is a day in the reader's zone.
 */
function holidaysOf(
  ctx: ExprContext,
  fn: string,
  raw: FormulaExpr | undefined,
  compile: () => Typed,
): Holidays | undefined {
  if (!raw) return undefined;
  const d = ctx.d;
  if (raw.op === "str") {
    const dates = raw.value.split(/[\s,;]+/).filter((date) => date !== "");
    if (dates.length > 1_000 || dates.some((date) => !isIsoDate(date))) {
      throw new AppError("invalid_arguments", fn);
    }
    const list =
      d.name === "postgres"
        ? `${ctx.params.bind(`{${dates.join(",")}}`)}::date[]`
        : d.textParam(ctx.params.bind(JSON.stringify(dates)));
    return { list, day: (alias) => d.listValue(`${alias}.v`, "date") };
  }
  const typed = compile();
  if (typed.kind !== "array") {
    return {
      list: d.listOne(asDate(ctx, typed), "date"),
      day: (alias) => d.listValue(`${alias}.v`, "date"),
    };
  }
  const elem = typed.elem;
  const value = (alias: string) => `${alias}.v`;
  switch (elem) {
    case "date":
      return {
        list: typed.sql,
        day: (alias) => d.listValue(value(alias), "date"),
      };
    case "datetime":
      return {
        list: typed.sql,
        day: (alias) =>
          d.localDate(
            d.name === "postgres" ? value(alias) : d.listInstant(value(alias)),
            ctx.tz,
          ),
      };
    case "text":
      return {
        list: typed.sql,
        day: (alias) =>
          d.localDate(d.textToInstant(value(alias), ctx.tz), ctx.tz),
      };
    default:
      throw new AppError("invalid_arguments", fn);
  }
}

/** Distinct weekday holidays in `[a, b]`. */
function holidayCount(
  d: SqlDialect,
  holidays: Holidays,
  a: string,
  b: string,
): string {
  const day = holidays.day("h");
  return `(select ${d.toInt(`count(distinct ${day})`)} from ${d.listFrom(holidays.list, "h")} where ${day} >= ${a} and ${day} <= ${b} and ${weekdayIndex(d, day)} < 5)`;
}

/**
 * WORKDAY with holidays, going forward (`sign` 1) or back (-1). Skipping
 * the holidays met on the way only moves the date further, so the answer
 * is reached from the first holiday h, in that direction, that lies
 * beyond the date found by skipping the holidays before h; without one,
 * all of them are skipped. No GROUP BY (MySQL's HAVING cannot read a
 * list's values) and no derived table reading the outer row (MariaDB's
 * cannot).
 */
function workdayAround(
  d: SqlDialect,
  holidays: Holidays,
  start: string,
  days: string,
  sign: 1 | -1,
): string {
  const [h1, h2] = [holidays.day("h1"), holidays.day("h2")];
  const ahead = sign === 1 ? ">" : "<";
  const behind = sign === 1 ? "<" : ">";
  const weekday = (day: string) => `${weekdayIndex(d, day)} < 5`;
  const skip = (count: string) =>
    workdaySql(d, start, `(${days} ${sign === 1 ? "+" : "-"} ${count})`);
  const count = (where: string, alias: string, day: string) =>
    `(select ${d.toInt(`count(distinct ${day})`)} from ${d.listFrom(holidays.list, alias)} where ${where})`;
  const before = count(
    `${h2} ${ahead} ${start} and ${h2} ${behind} ${h1} and ${weekday(h2)}`,
    "h2",
    h2,
  );
  const reached = skip(before);
  const top = d.name === "sqlserver" ? "top 1 " : "";
  const limit =
    d.name === "sqlserver"
      ? ""
      : d.name === "oracle"
        ? " fetch first 1 rows only"
        : " limit 1";
  const first = `(select ${top}${reached} from ${d.listFrom(holidays.list, "h1")} where ${h1} ${ahead} ${start} and ${weekday(h1)} and ${reached} ${behind} ${h1} order by ${h1}${sign === 1 ? "" : " desc"}${limit})`;
  const all = count(`${h1} ${ahead} ${start} and ${weekday(h1)}`, "h1", h1);
  return `coalesce(${first}, ${skip(all)})`;
}

/** The fixed-width fields DATETIME_PARSE reads, where ISO 8601 puts them. */
const PARSE_TOKENS = ["YYYY", "MM", "DD", "HH", "mm", "ss"] as const;

type ParsePlan = {
  length: number;
  fields: Map<(typeof PARSE_TOKENS)[number], number>;
  literals: Array<[number, string]>;
};

/**
 * A DATETIME_PARSE format: `YYYY`, `MM`, `DD`, then optionally `HH`, `mm`,
 * `ss`, each once, between literal characters. Every field has a fixed
 * width, so each sits at a known place in the text, on every engine.
 */
function parsePlan(format: string): ParsePlan {
  if (format.length === 0 || format.length > 64) {
    throw new AppError("invalid_arguments", "datetime_parse");
  }
  const fields = new Map<(typeof PARSE_TOKENS)[number], number>();
  const literals: Array<[number, string]> = [];
  let index = 0;
  while (index < format.length) {
    const token = PARSE_TOKENS.find((item) => format.startsWith(item, index));
    if (token) {
      if (fields.has(token)) {
        throw new AppError("invalid_arguments", "datetime_parse");
      }
      fields.set(token, index + 1);
      index += token.length;
      continue;
    }
    literals.push([index + 1, format[index] ?? ""]);
    index += 1;
  }
  const has = (token: (typeof PARSE_TOKENS)[number]) => fields.has(token);
  if (
    !has("YYYY") ||
    !has("MM") ||
    !has("DD") ||
    (has("mm") && !has("HH")) ||
    (has("HH") && !has("mm")) ||
    (has("ss") && !has("mm"))
  ) {
    throw new AppError("invalid_arguments", "datetime_parse");
  }
  return { length: format.length, fields, literals };
}

/** Compiles a formula AST against `table`, reading columns through `alias`. */
/**
 * The most SQL one formula compiles to. A function repeats its argument
 * where it guards it (`case when x >= 0 then sqrt(x) end`), so nested
 * calls and chained fields grow geometrically: past this, the formula is
 * refused instead of built.
 */
const MAX_FORMULA_SQL = ceilingOf("formula.sql_chars");

export function compileFormula(
  ctx: ExprContext,
  table: EngineTable,
  alias: string,
  expr: FormulaExpr,
  stack: readonly string[],
): Typed {
  const typed = compileNode(ctx, table, alias, expr, stack);
  if (typed.sql.length > MAX_FORMULA_SQL) {
    throw new AppError("formula_too_large");
  }
  return typed;
}

function compileNode(
  ctx: ExprContext,
  table: EngineTable,
  alias: string,
  expr: FormulaExpr,
  stack: readonly string[],
): Typed {
  switch (expr.op) {
    case "num": {
      const value = expr.exact ?? numberToDecimal(expr.value) ?? "0";
      return {
        sql: ctx.d.numberLiteral(
          ctx.params.bind(expr.exact ?? expr.value),
          value,
        ),
        kind: "number",
        digits: literalDigits(value),
        small: true,
      };
    }
    case "str":
      return {
        sql: ctx.d.textParam(ctx.params.bind(expr.value)),
        kind: "text",
        literal: expr.value,
      };
    case "bool":
      return { sql: ctx.d.boolLiteral(expr.value), kind: "boolean" };
    case "col": {
      const column = findColumn(table, expr.name);
      if (!column) {
        throw new AppError("unknown_column", expr.name);
      }
      return compileColumn(ctx, table, alias, column, stack);
    }
    case "neg": {
      const arg = sized(
        ctx,
        compileFormula(ctx, table, alias, expr.arg, stack),
      );
      return { sql: `(- ${arg.sql})`, kind: "number", digits: arg.digits };
    }
    case "if": {
      const cond = compileFormula(ctx, table, alias, expr.cond, stack);
      const [then, otherwise] = largeBranches(
        ctx,
        table,
        [expr.then, expr.else],
        stack,
        unify(ctx, [
          compileFormula(ctx, table, alias, expr.then, stack),
          compileFormula(ctx, table, alias, expr.else, stack),
        ]),
      );
      if (!then || !otherwise) {
        throw new AppError("invalid_formula");
      }
      return withSql(
        then,
        `(case when ${asBool(cond, ctx.d)} then ${then.sql} else ${otherwise.sql} end)`,
        caseDigits(ctx, [then, otherwise]),
      );
    }
    case "call":
      return compileCall(ctx, table, alias, expr.fn, expr.args, stack);
    case "concat": {
      // A chain of `&` is one join: each part is written once, however
      // long the chain.
      const parts = joinedParts(expr);
      return {
        sql: joinOf(
          ctx,
          parts.map((part) =>
            asText(ctx, compileFormula(ctx, table, alias, part, stack)),
          ),
          parts.some((part) => givesLargeObject(ctx, table, part, stack)),
        ),
        kind: "text",
      };
    }
    default: {
      const left = compileFormula(ctx, table, alias, expr.left, stack);
      const right = compileFormula(ctx, table, alias, expr.right, stack);
      switch (expr.op) {
        case "add":
        case "sub":
        case "mul":
        case "div":
          return arithmetic(ctx, expr.op, left, right);
        case "mod":
          return modulo(ctx, left, right);
        default:
          return {
            sql: ctx.d.boolValue(
              compare(
                ctx,
                expr.op,
                left,
                right,
                comparesLarge(ctx, table, [expr.left, expr.right], stack),
              ),
            ),
            kind: "boolean",
          };
      }
    }
  }
}

function withSql(shape: Typed, sql: string, digits?: Digits): Typed {
  if (shape.kind === "array") {
    return { sql, kind: "array", elem: shape.elem };
  }
  if (shape.kind === "null") {
    return { sql, kind: "null" };
  }
  return digits ? { sql, kind: shape.kind, digits } : { sql, kind: shape.kind };
}

/* ------------------------------------------------------------------ */
/* Arithmetic, and SQL Server's decimals (ADR 0027)                    */
/* ------------------------------------------------------------------ */

/** A number with the T-SQL type the compiler knows it has. */
type Sized = { sql: string; digits: Digits };

/** A number computed, its type, and whether T-SQL kept every digit. */
type Computed = Sized & { exact: boolean };

function sized(ctx: ExprContext, typed: Typed): Sized {
  const sql = asNumber(ctx, typed);
  switch (typed.kind) {
    case "number":
      return { sql, digits: typed.digits ?? UNKNOWN_DIGITS };
    case "boolean":
      return { sql, digits: INT_DIGITS };
    case "null":
      return { sql, digits: { p: 1, s: 0 } };
    default:
      return { sql, digits: UNKNOWN_DIGITS };
  }
}

function computed(ctx: ExprContext, result: Computed): Typed {
  if (!result.exact) notePrecision(ctx);
  return { sql: result.sql, kind: "number", digits: result.digits };
}

/**
 * A product or quotient whose whole part may outgrow its T-SQL type, which
 * would fail the whole read: estimated in floating point first, and blank
 * past what the type holds.
 */
function bounded(
  sql: string,
  a: Sized,
  b: Sized,
  op: "*" | "/",
  digits: Digits,
): string {
  const estimate =
    op === "*"
      ? `abs(cast(${a.sql} as float) * cast(${b.sql} as float))`
      : `abs(cast(${a.sql} as float) / nullif(cast(${b.sql} as float), 0))`;
  return `(case when ${estimate} < 1e${String(37 - digits.s)} then ${sql} end)`;
}

/**
 * `a / b` on SQL Server, to 20 decimals. When the types allow it the
 * dividend is widened so that T-SQL keeps 21 decimals or more, which it
 * truncates; the cast to 20 then rounds half away from zero, as
 * PostgreSQL does. Otherwise T-SQL's own scale stands, and the field says
 * it may be rounded.
 */
function sqlServerQuotient(a: Sized, b: Sized): Computed {
  const divisor = `nullif(${b.sql}, 0)`;
  const wide = exactDividend(a.digits, b.digits);
  if (wide) {
    const whole = wide.p - wide.s + b.digits.s;
    const digits = { p: whole + 21, s: 20 };
    return {
      sql: `cast(cast(${a.sql} as decimal(${String(wide.p)},${String(wide.s)})) / ${divisor} as decimal(${String(digits.p)},20))`,
      digits,
      exact: true,
    };
  }
  const { digits } = quotientDigits(a.digits, b.digits);
  let sql = `(${a.sql} / ${divisor})`;
  if (mayOverflow(a.digits, b.digits, "div")) {
    sql = bounded(sql, a, b, "/", digits);
  }
  return digits.s > 20
    ? {
        sql: `cast(${sql} as decimal(38,20))`,
        digits: { p: 38, s: 20 },
        exact: false,
      }
    : { sql, digits, exact: false };
}

/**
 * A mean on SQL Server, exact to 20 decimals: the whole quotient, then the
 * remainder, smaller than the count, divided with room for 21 decimals.
 * `value` is the type of what is averaged: the mean is no wider. Null when
 * the types leave no room.
 */
function sqlServerMean(
  sum: string,
  count: string,
  value: Digits,
): Computed | null {
  const whole = value.p - value.s;
  const scale = Math.max(value.s, 20);
  if (whole + 22 > 38 || 10 + scale > 38) return null;
  const rest = `(${sum} % ${count})`;
  const quotient = `cast((${sum} - ${rest}) / ${count} as decimal(${String(whole + 1)},0))`;
  const fraction = `cast(cast(${rest} as decimal(${String(10 + scale)},${String(scale)})) / ${count} as decimal(21,20))`;
  return {
    sql: `(case when ${count} = 0 then null else ${quotient} + ${fraction} end)`,
    digits: { p: whole + 22, s: 20 },
    exact: true,
  };
}

const OPERATORS = { add: "+", sub: "-", mul: "*" } as const;

/**
 * The size past which a number is blank in a product or as a dividend on
 * PostgreSQL: 65,000 digits. Its numbers stop at 131,072 digits before the
 * point, and it raises past them, which would cost the whole page for one
 * row. Two operands under this bound give a product it holds, and a
 * dividend under it a quotient it holds, whatever divides it.
 */
const POSTGRES_REACH = "1e65000";
/** `POWER` stops under the same size: its result is a product's operand. */
const POSTGRES_POWER_CEILING = "149000";
/** Past this, PostgreSQL's exponential raises: it stops at e to the 6,000. */
const POSTGRES_EXP_CEILING = "5999.9";

/**
 * A number of PostgreSQL's, blank at `POSTGRES_REACH` and past it. The
 * operand is written once: a guard that repeated it would double the
 * statement at each nested product.
 */
function withinReach(sql: string): string {
  const reach = POSTGRES_REACH;
  return `nullif(greatest(nullif(least(${sql}, ${reach}), ${reach}), -${reach}), -${reach})`;
}

function arithmetic(
  ctx: ExprContext,
  op: "add" | "sub" | "mul" | "div",
  left: Typed,
  right: Typed,
): Typed {
  if (ctx.d.name !== "sqlserver") {
    const [a, b] = [asNumber(ctx, left), asNumber(ctx, right)];
    if (ctx.d.name === "postgres" && (op === "mul" || op === "div")) {
      const near = (operand: Typed, sql: string) =>
        operand.kind === "number" && operand.small ? sql : withinReach(sql);
      return {
        sql:
          op === "div"
            ? ctx.d.divide(near(left, a), b)
            : `(${near(left, a)} * ${near(right, b)})`,
        kind: "number",
      };
    }
    return {
      sql: op === "div" ? ctx.d.divide(a, b) : `(${a} ${OPERATORS[op]} ${b})`,
      kind: "number",
    };
  }
  const [a, b] = [sized(ctx, left), sized(ctx, right)];
  if (op === "div") return computed(ctx, sqlServerQuotient(a, b));
  const result =
    op === "mul"
      ? productDigits(a.digits, b.digits)
      : sumDigits(a.digits, b.digits);
  const sql = `(${a.sql} ${OPERATORS[op]} ${b.sql})`;
  return computed(ctx, {
    sql:
      op === "mul" && mayOverflow(a.digits, b.digits, "mul")
        ? bounded(sql, a, b, "*", result.digits)
        : sql,
    ...result,
  });
}

/** `a` modulo `b`: T-SQL types it by the smaller whole part. */
function modulo(ctx: ExprContext, left: Typed, right: Typed): Typed {
  const [a, b] = [sized(ctx, left), sized(ctx, right)];
  const s = Math.max(a.digits.s, b.digits.s);
  const whole = Math.min(a.digits.p - a.digits.s, b.digits.p - b.digits.s);
  return {
    sql: ctx.d.mod(a.sql, b.sql),
    kind: "number",
    digits: { p: Math.max(whole + s, 1), s },
  };
}

/** The type of a CASE over numbers: their union, which T-SQL may round. */
function caseDigits(
  ctx: ExprContext,
  branches: readonly Typed[],
): Digits | undefined {
  if (!branches.every((branch) => branch.kind === "number")) return undefined;
  const union = unionDigits(
    branches.map((branch) =>
      branch.kind === "number"
        ? (branch.digits ?? UNKNOWN_DIGITS)
        : UNKNOWN_DIGITS,
    ),
  );
  if (!union.exact && ctx.d.name === "sqlserver") notePrecision(ctx);
  return union.digits;
}

/** A whole number T-SQL types as it likes, read as `bigint`'s digits. */
function wholeNumber(ctx: ExprContext, sql: string): Typed {
  return ctx.d.name === "sqlserver"
    ? {
        sql: `cast(${sql} as decimal(19,0))`,
        kind: "number",
        digits: BIGINT_DIGITS,
      }
    : { sql, kind: "number" };
}

function compileCall(
  ctx: ExprContext,
  table: EngineTable,
  alias: string,
  fn: keyof typeof FORMULA_FN_SPECS,
  rawArgs: readonly FormulaExpr[],
  stack: readonly string[],
): Typed {
  const spec = FORMULA_FN_SPECS[fn];
  if (rawArgs.length < spec.min || rawArgs.length > spec.max) {
    throw new AppError("invalid_arguments", fn);
  }
  const lazy = (index: number): Typed => {
    const raw = rawArgs[index];
    if (!raw) {
      throw new AppError("invalid_arguments", fn);
    }
    return compileFormula(ctx, table, alias, raw, stack);
  };
  const d = ctx.d;
  const num = (index: number): string => asNumber(ctx, lazy(index));
  const text = (index: number): string => asText(ctx, lazy(index));
  // What the engine computes differently runs, and the field says so.
  noteLimit(ctx, fn);
  const number = (sql: string, digits?: Digits): Typed =>
    digits ? { sql, kind: "number", digits } : { sql, kind: "number" };
  const textResult = (sql: string): Typed => ({ sql, kind: "text" });
  // A condition, as a boolean value.
  const bool = (sql: string): Typed => ({
    sql: d.boolValue(sql),
    kind: "boolean",
  });
  // On SQL Server a floating-point result reads back as decimal(38,18).
  const floating = (sql: string): Typed =>
    number(
      d.fromFloat(sql),
      d.name === "sqlserver" ? UNKNOWN_DIGITS : undefined,
    );
  switch (fn) {
    case "abs":
    case "sign": {
      const x = sized(ctx, lazy(0));
      return number(`${fn}(${x.sql})`, x.digits);
    }
    case "floor":
    case "int":
    case "ceil": {
      const x = sized(ctx, lazy(0));
      return number(fn === "ceil" ? d.ceil(x.sql) : `floor(${x.sql})`, {
        p: x.digits.p,
        s: 0,
      });
    }
    // PostgreSQL computes these exactly; other engines in floating point,
    // brought back to their exact numbers (an `approximate` limit). Their
    // doubles stop near 1e308: past `expCeiling` the result is blank there.
    case "sqrt": {
      const x = num(0);
      return floating(`(case when ${x} >= 0 then sqrt(${x}) end)`);
    }
    case "exp": {
      const x = num(0);
      return floating(
        `(case when ${x} <= ${String(d.expCeiling)} then exp(${x}) end)`,
      );
    }
    case "ln": {
      const x = num(0);
      return floating(`(case when ${x} > 0 then ${d.ln(x)} end)`);
    }
    case "log": {
      const x = num(0);
      const base = rawArgs.length > 1 ? num(1) : "10";
      return floating(
        `(case when ${x} > 0 and ${base} > 0 and ${base} <> 1 then ${d.log(base, x)} end)`,
      );
    }
    case "power": {
      const a = num(0);
      const b = num(1);
      const fractional = `${b} <> ${d.truncate(b, "0")}`;
      const ceiling =
        d.name === "postgres" ? POSTGRES_POWER_CEILING : String(d.expCeiling);
      // PostgreSQL multiplies out a whole exponent, to any size its numbers
      // hold; any other goes through its exponential, which raises far
      // sooner, and only when the result is large: a small one is zero.
      const exponential =
        d.name === "postgres"
          ? ` when ${fractional} and ${b} * ${d.ln(`abs(${a})`)} > ${POSTGRES_EXP_CEILING} then null`
          : "";
      return floating(
        `(case when ${a} = 0 then (case when ${b} > 0 then 0 when ${b} = 0 then 1 end) when ${a} < 0 and ${fractional} then null${exponential} when abs(${b}) * abs(${d.ln(`abs(${a})`)}) > ${ceiling} then null else ${d.power(a, b)} end)`,
      );
    }
    case "round":
    case "roundup":
    case "rounddown": {
      const digits = rawArgs.length > 1 ? clampInt(ctx, num(1), -20, 20) : "0";
      if (d.name === "sqlserver") {
        return sqlServerRound(ctx, fn, sized(ctx, lazy(0)), digits, rawArgs[1]);
      }
      const x = num(0);
      if (fn === "round") {
        return number(`round(${x}, ${digits})`);
      }
      if (fn === "rounddown") {
        return number(d.truncate(x, digits));
      }
      return number(d.roundUp(x, digits));
    }
    // Away from zero to the next even or odd whole number: EVEN(-1) is -2,
    // ODD(0) is 1.
    case "even":
    case "odd": {
      const x = sized(ctx, lazy(0));
      const up = d.ceil(`abs(${x.sql})`);
      const step = fn === "even" ? d.mod(up, "2") : `(1 - ${d.mod(up, "2")})`;
      const sql = `((case when ${x.sql} < 0 then -1 else 1 end) * (${up} + ${step}))`;
      const digits = { p: Math.min(38, x.digits.p - x.digits.s + 1), s: 0 };
      return d.name === "sqlserver"
        ? number(`cast(${sql} as decimal(${String(digits.p)},0))`, digits)
        : number(sql);
    }
    case "mod":
      return modulo(ctx, lazy(0), lazy(1));
    case "value":
      return number(num(0));
    case "sum":
    case "average":
    case "count": {
      const args = compileArgs(ctx, table, alias, rawArgs, stack);
      if (d.name !== "postgres") {
        return scalarAggregate(ctx, fn, args);
      }
      const values = numericArray(ctx, args);
      // A mean divides as `/` does: 20 decimals on every engine.
      const agg =
        fn === "sum"
          ? "sum(v)"
          : fn === "average"
            ? d.divide("sum(v)", "count(v)")
            : "count(v)::numeric";
      return number(`(select ${agg} from unnest(${values}) v)`);
    }
    case "min":
    case "max": {
      const args = compileArgs(ctx, table, alias, rawArgs, stack);
      if (d.name !== "postgres") {
        return scalarExtreme(ctx, fn, args);
      }
      const timed = datedAs(args);
      if (timed === "datetime") return instantExtreme(ctx, fn, args);
      if (timed === "date") {
        const parts = args.map((arg) =>
          arg.kind === "array" ? arg.sql : `array[${asDate(ctx, arg)}]::date[]`,
        );
        return {
          sql: `(select ${fn}(v) from unnest(${parts.join(" || ")}) v)`,
          kind: "date",
        };
      }
      return number(
        `(select ${fn}(v) from unnest(${numericArray(ctx, args)}) v)`,
      );
    }
    case "counta":
    case "countall": {
      const args = compileArgs(ctx, table, alias, rawArgs, stack);
      if (d.name !== "postgres") {
        // A list counts its values: all of them, or the filled ones.
        const counts = args.map((arg) =>
          arg.kind === "array"
            ? fn === "countall"
              ? `coalesce(${d.listLength(arg.sql)}, 0)`
              : `coalesce(${d.listAggregate(arg.sql, "counta", arg.elem)}, 0)`
            : fn === "countall"
              ? "1"
              : `(case when ${d.textFilled(`coalesce(${asText(ctx, arg)}, '')`)} then 1 else 0 end)`,
        );
        return number(`(${counts.join(" + ")})`, BIGINT_DIGITS);
      }
      const values = textArray(ctx, args);
      return number(
        fn === "countall"
          ? `coalesce(cardinality(${values}), 0)::numeric`
          : `(select count(*)::numeric from unnest(${values}) v where v is not null and v <> '')`,
      );
    }
    case "concat": {
      const args = compileArgs(ctx, table, alias, rawArgs, stack);
      return textResult(
        joinOf(
          ctx,
          args.map((arg) => asText(ctx, arg)),
          rawArgs.some((arg) => givesLargeObject(ctx, table, arg, stack)),
        ),
      );
    }
    case "lower":
      return textResult(`lower(${text(0)})`);
    case "upper":
      return textResult(`upper(${text(0)})`);
    case "len":
      return number(
        d.name === "postgres"
          ? `${d.textLength(text(0))}::numeric`
          : d.textLength(text(0)),
        BIGINT_DIGITS,
      );
    case "trim":
      return textResult(d.trim(text(0)));
    case "left":
      return textResult(d.textLeft(text(0), clampInt(ctx, num(1), 0, 100_000)));
    case "right":
      return textResult(
        d.textRight(text(0), clampInt(ctx, num(1), 0, 100_000)),
      );
    case "mid": {
      const start = clampInt(ctx, num(1), 1, 100_000);
      return textResult(
        rawArgs.length > 2
          ? d.textSlice(text(0), start, clampInt(ctx, num(2), 0, 100_000))
          : d.textFrom(text(0), start),
      );
    }
    // What comes before or after the first delimiter, matched exactly;
    // blank when it is not there, as the text is.
    case "text_before":
    case "text_after": {
      const value = text(0);
      const delimiter = text(1);
      const at = d.locate(delimiter, value, "1", false);
      const part =
        fn === "text_before"
          ? d.textLeft(value, `${at} - 1`)
          : d.textFrom(value, `${at} + ${d.textLength(delimiter)}`);
      // An empty delimiter sits before the first character.
      const empty = fn === "text_before" ? "''" : value;
      return textResult(
        `(case when ${value} is null then null when not ${d.textFilled(delimiter)} then ${empty} when ${at} > 0 then ${part} end)`,
      );
    }
    case "md5":
    case "sha256":
    case "sha512":
      return textResult(d.hashHex(text(0), fn));
    // A pattern written in the formula, in the portable subset; SQL Server
    // reads none.
    case "regex_match":
    case "regex_extract":
    case "regex_replace": {
      const written = rawArgs[1];
      if (!written || written.op !== "str") {
        throw new AppError("invalid_arguments", fn);
      }
      const regex = portableRegex(written.value, fn);
      const bind = (value: unknown) => ctx.params.bind(value);
      const value = text(0);
      if (fn === "regex_match") {
        return bool(d.truth(d.regexMatch(value, regex, bind)));
      }
      if (regex.ambiguous) {
        const limit = regexLimit(d.name, fn);
        if (limit) ctx.limits?.set(limitKey(limit), limit);
      }
      if (fn === "regex_extract") {
        return textResult(d.regexExtract(value, regex, bind));
      }
      const replacement = rawArgs[2];
      return textResult(
        d.regexReplace(
          value,
          regex,
          replacement?.op === "str"
            ? regexReplacement(replacement.value, regex.groups, fn)
            : { sql: `coalesce(${text(2)}, '')` },
          bind,
        ),
      );
    }
    // The value at a path written in the formula. PostgreSQL checks the
    // text is JSON without failing the read only from version 16.
    case "json_extract": {
      const path = rawArgs[1];
      if (!path || path.op !== "str") {
        throw new AppError("invalid_arguments", fn);
      }
      const steps = parseJsonPath(path.value);
      if (d.name === "postgres" && !serverAtLeast(d, [16])) {
        return d.unavailable("JSON_EXTRACT");
      }
      return textResult(
        d.jsonExtract(text(0), steps, (value) => ctx.params.bind(value)),
      );
    }
    case "find":
    case "search": {
      const start =
        rawArgs.length > 2 ? clampInt(ctx, num(2), 1, 100_000) : "1";
      if (d.name !== "postgres") {
        return number(
          d.locate(text(0), text(1), start, fn === "search"),
          BIGINT_DIGITS,
        );
      }
      const fold = (sql: string): string =>
        fn === "search" ? `lower(${sql})` : sql;
      const needle = fold(text(0));
      const haystack = fold(text(1));
      return number(
        `(case when ${needle} is null or ${haystack} is null then null else ${d.locate(needle, haystack, start, false)}::numeric end)`,
      );
    }
    case "substitute":
      return textResult(
        d.replaceText(text(0), text(1), `coalesce(${text(2)}, '')`),
      );
    case "replace":
      return textResult(
        d.overlay(
          text(0),
          `coalesce(${text(3)}, '')`,
          clampInt(ctx, num(1), 1, 100_000),
          clampInt(ctx, num(2), 0, 100_000),
        ),
      );
    case "rept": {
      const value = text(0);
      const times = reptCount(ctx, num(1));
      return textResult(
        `(case when ${d.textLength(value)} * ${times} <= ${String(MAX_REPT_TEXT)} then ${d.repeat(value, times)} end)`,
      );
    }
    case "t": {
      const arg = lazy(0);
      return textResult(arg.kind === "text" ? arg.sql : "''");
    }
    case "encode_url_component":
      return textResult(d.encodeUrl(text(0)));
    case "and":
    case "or": {
      const args = compileArgs(ctx, table, alias, rawArgs, stack);
      const joiner = fn === "and" ? " and " : " or ";
      return bool(`(${args.map((arg) => asBool(arg, ctx.d)).join(joiner)})`);
    }
    case "xor": {
      const args = compileArgs(ctx, table, alias, rawArgs, stack);
      return bool(
        `(${ctx.d.mod(`(${args.map((arg) => `(case when ${asBool(arg, ctx.d)} then 1 else 0 end)`).join(" + ")})`, "2")} = 1)`,
      );
    }
    case "not":
      return bool(`(not ${asBool(lazy(0), ctx.d)})`);
    case "if": {
      const cond = lazy(0);
      const branches = largeBranches(
        ctx,
        table,
        [rawArgs[1], rawArgs[2]],
        stack,
        unify(ctx, [
          lazy(1),
          rawArgs.length > 2 ? lazy(2) : { sql: "null", kind: "null" },
        ]),
      );
      const [then, otherwise] = branches;
      if (!then || !otherwise) {
        throw new AppError("invalid_formula");
      }
      return withSql(
        then,
        `(case when ${asBool(cond, ctx.d)} then ${then.sql} else ${otherwise.sql} end)`,
        caseDigits(ctx, [then, otherwise]),
      );
    }
    case "switch": {
      const subject = lazy(0);
      const rest = compileArgs(ctx, table, alias, rawArgs.slice(1), stack);
      const hasDefault = rest.length % 2 === 1;
      const given = rawArgs
        .slice(1)
        .filter(
          (_, index, all) =>
            index % 2 === 1 || (hasDefault && index === all.length - 1),
        );
      const results = largeBranches(
        ctx,
        table,
        given,
        stack,
        unify(ctx, [
          ...rest.filter((_, index) => index % 2 === 1),
          ...(hasDefault
            ? [rest[rest.length - 1] ?? { sql: "null", kind: "null" as const }]
            : []),
        ]),
      );
      const pairs: string[] = [];
      for (let index = 0; index + 1 < rest.length; index += 2) {
        const match = rest[index];
        const result = results[index / 2];
        if (!match || !result) {
          throw new AppError("invalid_formula");
        }
        pairs.push(
          `when ${compare(ctx, "eq", subject, match, comparesLarge(ctx, table, [rawArgs[0], rawArgs[index + 1]], stack))} then ${result.sql}`,
        );
      }
      const fallback = hasDefault ? results[results.length - 1] : undefined;
      const shape = results[0] ?? { sql: "null", kind: "null" as const };
      return withSql(
        shape,
        `(case ${pairs.join(" ")}${fallback ? ` else ${fallback.sql}` : ""} end)`,
        caseDigits(ctx, results),
      );
    }
    case "true":
    case "false":
      return compileFormula(
        ctx,
        table,
        alias,
        { op: "bool", value: fn === "true" },
        stack,
      );
    case "blank":
      return { sql: "null", kind: "null" };
    // An error's value is blank; its message travels beside it
    // (`formulaError`, ADR 0036).
    case "error":
      return { sql: "null", kind: "null" };
    case "is_error": {
      const [arg] = rawArgs;
      const error = arg
        ? formulaError(ctx, table, alias, arg, stack)
        : undefined;
      return bool(error ? `(${error} is not null)` : "(1 = 0)");
    }
    case "is_blank":
    case "is_not_blank": {
      const arg = lazy(0);
      const empty =
        arg.kind === "text"
          ? `(${arg.sql} is null or not ${d.textFilled(arg.sql)})`
          : arg.kind === "array"
            ? `(coalesce(${d.listLength(arg.sql)}, 0) = 0)`
            : arg.kind === "null"
              ? "(1 = 1)"
              : `(${arg.sql} is null)`;
      return bool(fn === "is_blank" ? empty : `(not ${empty})`);
    }
    case "today":
      return { sql: d.today(ctx.tz), kind: "date" };
    case "now":
      return { sql: d.now(), kind: "datetime" };
    case "year":
    case "month":
    case "day":
    case "hour":
    case "minute":
    case "second":
      return dateFunction(ctx, fn, lazy(0));
    case "weekday":
      return dateFunction(ctx, "dow", lazy(0));
    case "weeknum":
      return dateFunction(ctx, "week", lazy(0));
    case "datetime_diff":
      return dateDiff(
        ctx,
        lazy(0),
        lazy(1),
        normalizeUnit(literalString(rawArgs[2], "days")),
      );
    case "date_add": {
      const base = lazy(0);
      const amount = clampInt(ctx, num(1), -1_000_000, 1_000_000);
      const unit = normalizeUnit(literalString(rawArgs[2], "days"));
      if (
        base.kind === "date" &&
        unit !== "hour" &&
        unit !== "minute" &&
        unit !== "second"
      ) {
        return { sql: d.addUnit(base.sql, amount, unit, true), kind: "date" };
      }
      return {
        sql: d.addUnit(asDatetime(ctx, base), amount, unit, false),
        kind: "datetime",
      };
    }
    case "datestr":
      return textResult(d.dateText(asDate(ctx, lazy(0))));
    // How far a date is from now, whichever side: DATETIME_DIFF's units,
    // days by default. A date counts from today.
    case "fromnow":
    case "tonow": {
      const unit = normalizeUnit(literalString(rawArgs[1], "days"));
      const daily = unit !== "hour" && unit !== "minute" && unit !== "second";
      const value = lazy(0);
      noteLimit(ctx, "datetime_diff");
      const now: Typed =
        daily && value.kind === "date"
          ? { sql: d.today(ctx.tz), kind: "date" }
          : { sql: d.now(), kind: "datetime" };
      const diff = dateDiff(ctx, now, value, unit);
      return withSql(
        diff,
        `abs(${diff.sql})`,
        diff.kind === "number" ? diff.digits : undefined,
      );
    }
    case "workday": {
      const start = asDate(ctx, lazy(0));
      const days = clampInt(ctx, num(1), -100_000, 100_000);
      const holidays = holidaysOf(ctx, fn, rawArgs[2], () => lazy(2));
      if (!holidays) return { sql: workdaySql(d, start, days), kind: "date" };
      return {
        sql: `(case when ${days} > 0 then ${workdayAround(d, holidays, start, days, 1)} when ${days} < 0 then ${workdayAround(d, holidays, start, days, -1)} else ${start} end)`,
        kind: "date",
      };
    }
    // Working days from one date to another, both counted; negative when
    // the second comes first.
    case "workday_diff": {
      const a = asDate(ctx, lazy(0));
      const b = asDate(ctx, lazy(1));
      const holidays = holidaysOf(ctx, fn, rawArgs[2], () => lazy(2));
      const between = (from: string, to: string) =>
        holidays
          ? `(${workdayCount(d, from, to)} - ${holidayCount(d, holidays, from, to)})`
          : workdayCount(d, from, to);
      return number(
        `(case when ${b} >= ${a} then ${between(a, b)} else -${between(b, a)} end)`,
        INT_DIGITS,
      );
    }
    // Text read as a date and time: by AnyGridDB's grammar, or by a format
    // of fixed-width fields. A time is in the reader's zone; a format
    // without one gives a date. What does not read is blank.
    case "datetime_parse": {
      const value = lazy(0);
      const format = rawArgs[1];
      if (!format) return { sql: asDatetime(ctx, value), kind: "datetime" };
      if (format.op !== "str") throw new AppError("invalid_formula");
      const plan = parsePlan(format.value);
      const source = asText(ctx, value);
      const at = (token: (typeof PARSE_TOKENS)[number], width: number) => {
        const place = plan.fields.get(token);
        return place === undefined
          ? undefined
          : d.textSlice(source, String(place), String(width));
      };
      const [hour, minute, second] = [at("HH", 2), at("mm", 2), at("ss", 2)];
      const parts = [
        at("YYYY", 4),
        "'-'",
        at("MM", 2),
        "'-'",
        at("DD", 2),
        ...(hour && minute ? ["' '", hour, "':'", minute] : []),
        ...(second ? ["':'", second] : []),
      ].filter((part): part is string => part !== undefined);
      const checks = [
        `${d.textLength(source)} = ${String(plan.length)}`,
        ...plan.literals.map(([place, char]) =>
          d.compareText(
            d.textSlice(source, String(place), "1"),
            "=",
            d.textParam(ctx.params.bind(char)),
          ),
        ),
      ].join(" and ");
      const instant = d.wallClockInstant(
        d.concatAll(parts),
        ctx.tz,
        second ? "second" : hour ? "minute" : "date",
      );
      return hour
        ? { sql: `(case when ${checks} then ${instant} end)`, kind: "datetime" }
        : {
            sql: `(case when ${checks} then ${d.localDate(instant, ctx.tz)} end)`,
            kind: "date",
          };
    }
    case "datetime_format": {
      const pattern = rawArgs[1];
      if (!pattern || pattern.op !== "str") {
        throw new AppError("invalid_formula");
      }
      const value = lazy(0);
      return textResult(
        d.formatTimestamp(wallClock(ctx, value), pattern.value, (format) =>
          ctx.params.bind(format),
        ),
      );
    }
    case "is_before":
    case "is_after": {
      const left = lazy(0);
      const right = lazy(1);
      const symbol = fn === "is_before" ? "<" : ">";
      // Two days compare as days. Anything else is read as the instant it
      // names: two texts compared as texts gave the order of their letters.
      return bool(
        left.kind === "date" && right.kind === "date"
          ? `(${left.sql} ${symbol} ${right.sql})`
          : `(${asDatetime(ctx, left)} ${symbol} ${asDatetime(ctx, right)})`,
      );
    }
    case "is_same": {
      const unit = normalizeUnit(literalString(rawArgs[2], "day"));
      return bool(
        d.sameUnit(wallClock(ctx, lazy(0)), wallClock(ctx, lazy(1)), unit),
      );
    }
    case "record_id":
      return textResult(d.keyText(idSql(table, alias)));
    case "autonumber":
      return number(
        d.name === "postgres"
          ? `${systemSql(table, alias, "ag_seq")}::numeric`
          : systemSql(table, alias, "ag_seq"),
      );
    case "created_time":
      return {
        sql: systemSql(table, alias, "ag_created_at"),
        kind: "datetime",
      };
    case "last_modified_time":
      return {
        sql: systemSql(table, alias, "ag_updated_at"),
        kind: "datetime",
      };
    case "array_join": {
      const arg = lazy(0);
      const separator = rawArgs.length > 1 ? text(1) : "', '";
      return textResult(
        arg.kind === "array" ? listText(ctx, arg, separator) : asText(ctx, arg),
      );
    }
    case "text_split":
      return {
        sql: d.textSplit(text(0), text(1)),
        kind: "array",
        elem: "text",
      };
    // In order, blanks last: "asc" (the default) or "desc".
    case "array_sort": {
      const order = literalString(rawArgs[1], "asc");
      if (order !== "asc" && order !== "desc") {
        throw new AppError("invalid_arguments", fn);
      }
      const list = asList(ctx, lazy(0));
      return {
        sql: d.listSort(list.sql, list.elem, order === "desc"),
        kind: "array",
        elem: list.elem,
      };
    }
    // From place `from` to place `to`, both kept, counted from 1; a
    // negative place counts from the end (-1 is the last).
    case "array_slice": {
      const list = asList(ctx, lazy(0));
      const length = `coalesce(${d.listLength(list.sql)}, 0)`;
      const place = (sql: string) =>
        `(case when ${sql} < 0 then ${length} + ${sql} + 1 else ${sql} end)`;
      const from = place(clampInt(ctx, num(1), -100_000, 100_000));
      const to =
        rawArgs.length > 2
          ? place(clampInt(ctx, num(2), -100_000, 100_000))
          : length;
      return {
        sql: d.listSlice(list.sql, list.elem, from, to),
        kind: "array",
        elem: list.elem,
      };
    }
    // Every value of every list, one list after the other.
    case "array_flatten": {
      const lists = compileArgs(ctx, table, alias, rawArgs, stack)
        .filter((arg) => arg.kind !== "null")
        .map((arg) => asList(ctx, arg));
      const [head] = lists;
      if (!head) return emptyArray("text", d);
      if (lists.some((list) => list.elem !== head.elem)) {
        throw new AppError("invalid_arguments", fn);
      }
      return {
        sql: d.listConcat(
          lists.map((list) => list.sql),
          head.elem,
        ),
        kind: "array",
        elem: head.elem,
      };
    }
    case "array_unique":
    case "array_compact": {
      const arg = lazy(0);
      if (arg.kind !== "array") {
        return arg;
      }
      return {
        sql:
          fn === "array_unique"
            ? d.listUnique(arg.sql, arg.elem)
            : d.listCompact(arg.sql, arg.elem),
        kind: "array",
        elem: arg.elem,
      };
    }
  }
}
