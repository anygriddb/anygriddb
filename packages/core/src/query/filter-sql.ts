import { numberToDecimal, toDecimalString } from "../decimal";
import {
  OPERATORS_BY_KIND,
  isFilterGroup,
  type DateFilterValue,
  type FilterCondition,
  type FilterGroup,
  type FilterKind,
  type FilterValue,
} from "../filter";
import { isIsoDate } from "../cell-values";
import type { ScalarKind } from "./expressions";
import { POSTGRES, type SqlDialect } from "./dialect";
import { quoteIdent, type SqlParams } from "./params";
import { AppError } from "../errors";

/** A column as the derived table `q` exposes it to filters, sorts, and groups. */
export type ColumnRef = {
  name: string;
  kind: FilterKind;
  /**
   * The SQL that reads the column, where it is not `q."name"`: a linked
   * row's field, for a lookup's or rollup's condition.
   */
  expression?: string;
  elem?: ScalarKind;
  /** Option names in display order, for single and multi selects. */
  options?: readonly string[];
};

export type FilterContext = {
  params: SqlParams;
  /** The engine the query runs on (ADR 0005). */
  d: SqlDialect;
  /** Bound time-zone placeholder. */
  tz: string;
  /** Session user id, substituted for `me`. */
  me?: string;
  columns: ReadonlyMap<string, ColumnRef>;
};

export function refSql(name: string): string {
  return `q.${quoteIdent(name)}`;
}

function likePattern(
  value: string,
  mode: "contains" | "starts" | "ends",
): string {
  const escaped = value.replace(/[\\%_]/g, (char) => `\\${char}`);
  if (mode === "starts") return `${escaped}%`;
  if (mode === "ends") return `%${escaped}`;
  return `%${escaped}%`;
}

export function emptySql(ref: ColumnRef, d: SqlDialect = POSTGRES): string {
  const x = ref.expression ?? refSql(ref.name);
  switch (ref.kind) {
    case "text":
      return `(coalesce(${x}, '') = '')`;
    case "links":
      return `(coalesce(${d.linksLength(x)}, 0) = 0)`;
    case "options":
    case "users":
    case "files":
    case "array":
      return `(coalesce(${d.listLength(x)}, 0) = 0)`;
    default:
      return `(${x} is null)`;
  }
}

function textValue(value: FilterValue | undefined): string | undefined {
  if (typeof value === "string") {
    return value === "" ? undefined : value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function listValue(
  value: FilterValue | undefined,
  me: string | undefined,
): string[] | undefined {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string" && value !== ""
      ? [value]
      : undefined;
  if (!items || items.length === 0) {
    return undefined;
  }
  return items.map((item) => (item === "me" && me ? me : item));
}

/** A filter's number, kept exact: it is bound as text and cast to numeric. */
function numberValue(value: FilterValue | undefined): string | undefined {
  if (typeof value === "number") {
    return numberToDecimal(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    return toDecimalString(value);
  }
  return undefined;
}

type DateRange = { start: string; end: string };

/** A calendar day, bound and cast to the engine's date. */
function dateParam(ctx: FilterContext, date: string): string {
  const bound = ctx.params.bind(date);
  return ctx.d.name === "postgres"
    ? `${bound}::date`
    : `cast(${bound} as date)`;
}

/**
 * `is_between`: `[from, to]`, both ends included, a blank end open. Dates
 * compare by calendar day, a date and time in the reader's time zone.
 */
function betweenSql(
  ctx: FilterContext,
  ref: ColumnRef,
  value: FilterValue | undefined,
): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw new AppError("invalid_filter");
  }
  const d = ctx.d;
  const x = ref.expression ?? refSql(ref.name);
  let subject: string;
  let bound: (end: string) => string | undefined;
  if (ref.kind === "number") {
    subject = x;
    bound = (end) => {
      const number = numberValue(end);
      return number === undefined
        ? undefined
        : d.numberParam(ctx.params.bind(number));
    };
  } else if (ref.kind === "date" || ref.kind === "datetime") {
    subject = ref.kind === "datetime" ? d.localDate(x, ctx.tz) : x;
    bound = (end) => {
      const day = end.slice(0, 10);
      return isIsoDate(day) ? dateParam(ctx, day) : undefined;
    };
  } else {
    throw new AppError("invalid_filter");
  }
  const [from, to] = value.map(bound);
  const parts = [
    ...(from === undefined ? [] : [`${subject} >= ${from}`]),
    ...(to === undefined ? [] : [`${subject} <= ${to}`]),
  ];
  return parts.length === 0 ? null : `(${parts.join(" and ")})`;
}

function dateRange(
  ctx: FilterContext,
  value: FilterValue | undefined,
  within: boolean,
): DateRange | undefined {
  let spec: DateFilterValue | undefined;
  if (typeof value === "string") {
    spec = isIsoDate(value.slice(0, 10))
      ? { mode: "exact", date: value.slice(0, 10) }
      : undefined;
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    spec = value;
  }
  if (!spec) {
    return undefined;
  }
  const d = ctx.d;
  const today = (): string => d.today(ctx.tz);
  const days = (): string => d.intParam(ctx.params.bind(spec.days ?? 0));
  const plus = (base: string, amount: string): string =>
    d.addDays(base, amount);
  const minus = (base: string, amount: string): string =>
    d.addDays(base, `-${amount}`);
  const months = (base: string, amount: number, unit: "month" | "year") =>
    d.addPeriod(base, amount, unit);
  const period = (
    unit: "week" | "month" | "year",
    offset: number,
  ): DateRange => {
    const first = d.startOf(today(), unit);
    const start =
      offset === 0
        ? first
        : unit === "week"
          ? plus(first, String(offset * 7))
          : months(first, offset, unit);
    const end = unit === "week" ? plus(start, "7") : months(start, 1, unit);
    return { start, end };
  };
  if (within) {
    switch (spec.mode) {
      case "past_week":
        return { start: minus(today(), "7"), end: plus(today(), "1") };
      case "past_month":
        return {
          start: months(today(), -1, "month"),
          end: plus(today(), "1"),
        };
      case "past_year":
        return {
          start: months(today(), -1, "year"),
          end: plus(today(), "1"),
        };
      case "next_week":
        return { start: today(), end: plus(today(), "8") };
      case "next_month":
        return {
          start: today(),
          end: plus(months(today(), 1, "month"), "1"),
        };
      case "next_year":
        return {
          start: today(),
          end: plus(months(today(), 1, "year"), "1"),
        };
      case "past_days": {
        const n = days();
        return { start: minus(today(), n), end: plus(today(), "1") };
      }
      case "next_days": {
        const n = days();
        return { start: today(), end: plus(plus(today(), n), "1") };
      }
      case "this_week":
        return period("week", 0);
      case "this_month":
        return period("month", 0);
      case "this_year":
        return period("year", 0);
      default:
        return undefined;
    }
  }
  switch (spec.mode) {
    case "today":
      return { start: today(), end: plus(today(), "1") };
    case "yesterday":
      return { start: minus(today(), "1"), end: today() };
    case "tomorrow":
      return { start: plus(today(), "1"), end: plus(today(), "2") };
    case "days_ago": {
      const n = days();
      const start = minus(today(), n);
      return { start, end: plus(start, "1") };
    }
    case "days_from_now": {
      const n = days();
      const start = plus(today(), n);
      return { start, end: plus(start, "1") };
    }
    case "this_week":
      return period("week", 0);
    case "last_week":
      return period("week", -1);
    case "next_week":
      return period("week", 1);
    case "this_month":
      return period("month", 0);
    case "last_month":
      return period("month", -1);
    case "next_month":
      return period("month", 1);
    case "this_year":
      return period("year", 0);
    case "last_year":
      return period("year", -1);
    case "next_year":
      return period("year", 1);
    case "exact": {
      if (!spec.date) {
        return undefined;
      }
      const date = dateParam(ctx, spec.date);
      return { start: date, end: plus(date, "1") };
    }
    default:
      return undefined;
  }
}

/** Compiles one condition, or returns null when its value is still blank. */
export function compileCondition(
  ctx: FilterContext,
  condition: FilterCondition,
): string | null {
  const ref = ctx.columns.get(condition.column);
  if (!ref) {
    throw new AppError("unknown_column", condition.column);
  }
  if (!OPERATORS_BY_KIND[ref.kind].includes(condition.op)) {
    throw new AppError("invalid_filter");
  }
  const x = ref.expression ?? refSql(ref.name);
  const { op, value } = condition;
  const d = ctx.d;
  if (op === "is_empty") {
    return emptySql(ref, d);
  }
  if (op === "is_not_empty") {
    return `(not ${emptySql(ref, d)})`;
  }
  if (op === "is_between") {
    return betweenSql(ctx, ref, value);
  }
  switch (ref.kind) {
    case "boolean": {
      if (typeof value !== "boolean") {
        return null;
      }
      return `(coalesce(${x}, ${d.boolLiteral(false)}) = ${d.boolLiteral(value)})`;
    }
    case "text": {
      if (op === "is_any_of" || op === "is_none_of") {
        const items = listValue(value, ctx.me);
        if (!items) return null;
        const list = d.textList(items, (item) => ctx.params.bind(item));
        return op === "is_any_of"
          ? `(${d.inTexts(x, list)})`
          : `(${x} is null or not (${d.inTexts(x, list)}))`;
      }
      const text = textValue(value);
      if (text === undefined) {
        return null;
      }
      switch (op) {
        case "is":
          return `(lower(${x}) = lower(${d.textParam(ctx.params.bind(text))}))`;
        case "is_not":
          return `(${x} is null or lower(${x}) <> lower(${d.textParam(ctx.params.bind(text))}))`;
        case "contains":
          return `(${d.like(x, ctx.params.bind(likePattern(text, "contains")))})`;
        case "not_contains":
          return `(not ${d.like(`coalesce(${x}, '')`, ctx.params.bind(likePattern(text, "contains")))})`;
        case "starts_with":
          return `(${d.like(x, ctx.params.bind(likePattern(text, "starts")))})`;
        case "ends_with":
          return `(${d.like(x, ctx.params.bind(likePattern(text, "ends")))})`;
        default:
          throw new AppError("invalid_filter");
      }
    }
    case "number": {
      const number = numberValue(value);
      if (number === undefined) {
        return null;
      }
      const bound = d.numberParam(ctx.params.bind(number));
      const symbol = {
        is: "=",
        is_not: "<>",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
      }[op as "is" | "is_not" | "gt" | "gte" | "lt" | "lte"];
      if (!symbol) {
        throw new AppError("invalid_filter");
      }
      return op === "is_not"
        ? `(${x} is null or ${x} <> ${bound})`
        : `(${x} ${symbol} ${bound})`;
    }
    case "date":
    case "datetime": {
      const range = dateRange(ctx, value, op === "is_within");
      if (!range) {
        return null;
      }
      const day = ref.kind === "datetime" ? d.localDate(x, ctx.tz) : x;
      const inside = `(${day} >= ${range.start} and ${day} < ${range.end})`;
      switch (op) {
        case "is":
        case "is_within":
          return inside;
        case "is_not":
          return `(${day} is null or not ${inside})`;
        case "is_before":
          return `(${day} < ${range.start})`;
        case "is_after":
          return `(${day} >= ${range.end})`;
        case "is_on_or_before":
          return `(${day} < ${range.end})`;
        case "is_on_or_after":
          return `(${day} >= ${range.start})`;
        default:
          throw new AppError("invalid_filter");
      }
    }
    case "user": {
      const items = listValue(value, ctx.me);
      if (!items) return null;
      if (d.name !== "postgres") return d.unavailable("user");
      const list = ctx.params.bindTextArray(items);
      switch (op) {
        case "is":
        case "is_any_of":
          return `(${x}::text = any(${list}))`;
        case "is_not":
        case "is_none_of":
          return `(${x} is null or not (${x}::text = any(${list})))`;
        default:
          throw new AppError("invalid_filter");
      }
    }
    case "links": {
      if (op === "contains" || op === "not_contains") {
        const text = textValue(value);
        if (text === undefined) return null;
        const pattern = ctx.params.bind(likePattern(text, "contains"));
        const exists = d.linksLabelLike(x, pattern);
        return op === "contains" ? exists : `(not ${exists})`;
      }
      const items = listValue(value, ctx.me);
      if (!items) return null;
      const exists = d.linksIdIn(
        x,
        d.textList(items, (item) => ctx.params.bind(item)),
      );
      return op === "has_any_of" ? exists : `(not ${exists})`;
    }
    case "options":
    case "users":
    case "files":
    case "array": {
      if (d.name !== "postgres") {
        // Lists of an engine without arrays are JSON lists of text.
        if (ref.kind !== "array") return d.unavailable(ref.kind);
        if (op === "contains" || op === "not_contains") {
          const text = textValue(value);
          if (text === undefined) return null;
          const like = d.listTextLike(
            x,
            ctx.params.bind(likePattern(text, "contains")),
          );
          return op === "contains" ? like : `(not ${like})`;
        }
        const items = listValue(value, ctx.me);
        if (!items) return null;
        const test = {
          has_any_of: "any",
          has_all_of: "all",
          has_none_of: "none",
          is_exactly: "exactly",
        } as const;
        const kind = test[op as keyof typeof test] as
          (typeof test)[keyof typeof test] | undefined;
        if (!kind) throw new AppError("invalid_filter");
        return d.listHas(x, kind, items, (item) => ctx.params.bind(item));
      }
      const asText =
        ref.kind === "options" || (ref.kind === "array" && ref.elem === "text")
          ? x
          : `${x}::text[]`;
      if (op === "contains" || op === "not_contains") {
        const text = textValue(value);
        if (text === undefined) return null;
        const pattern = ctx.params.bind(likePattern(text, "contains"));
        const exists = `exists (select 1 from unnest(${asText}) v where v ilike ${pattern} escape '\\')`;
        return op === "contains" ? exists : `(not ${exists})`;
      }
      const items = listValue(value, ctx.me);
      if (!items) return null;
      const list = ctx.params.bindTextArray(items);
      switch (op) {
        case "has_any_of":
          return `coalesce(${asText} && ${list}, false)`;
        case "has_all_of":
          return `coalesce(${asText} @> ${list}, false)`;
        case "has_none_of":
          return `(not coalesce(${asText} && ${list}, false))`;
        case "is_exactly":
          return `coalesce(${asText} @> ${list} and ${asText} <@ ${list}, false)`;
        default:
          throw new AppError("invalid_filter");
      }
    }
  }
}

/** Compiles a filter tree. Returns null when nothing constrains the rows. */
export function compileFilter(
  ctx: FilterContext,
  group: FilterGroup | undefined,
): string | null {
  if (!group) {
    return null;
  }
  const parts: string[] = [];
  for (const node of group.conditions) {
    const sql = isFilterGroup(node)
      ? compileFilter(ctx, node)
      : compileCondition(ctx, node);
    if (sql) {
      parts.push(sql);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return `(${parts.join(group.conjunction === "and" ? " and " : " or ")})`;
}

/** Global search: ILIKE over every text-like column. */
export function compileSearch(
  ctx: FilterContext,
  search: string | undefined,
): string | null {
  const text = search?.trim();
  if (!text) {
    return null;
  }
  const d = ctx.d;
  const pattern = d.textParam(ctx.params.bind(likePattern(text, "contains")));
  const parts: string[] = [];
  for (const ref of ctx.columns.values()) {
    const x = refSql(ref.name);
    switch (ref.kind) {
      case "text":
        parts.push(d.like(x, pattern));
        break;
      case "number":
        parts.push(d.like(d.numberText(x), pattern));
        break;
      case "date":
        parts.push(d.like(d.dateText(x), pattern));
        break;
      case "options":
      case "array":
        parts.push(
          d.name === "postgres"
            ? `array_to_string(${x}, ' ') ilike ${pattern}`
            : d.listTextLike(x, pattern),
        );
        break;
      case "links":
        parts.push(d.linksLabelLike(x, pattern));
        break;
      default:
        break;
    }
  }
  if (parts.length === 0) {
    return "false";
  }
  return `(${parts.join(" or ")})`;
}
