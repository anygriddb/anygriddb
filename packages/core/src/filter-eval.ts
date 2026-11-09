/**
 * A filter read in the application, for values that are not rows yet: a
 * form's answers, before they are sent. It means what the compiled filter
 * means (`query/filter-sql.ts`): the same operators, a blank value leaving
 * a condition out, `me`, and relative dates in the reader's time zone.
 */
import {
  OPERATORS_BY_KIND,
  isFilterGroup,
  type DateFilterValue,
  type FilterCondition,
  type FilterGroup,
  type FilterKind,
  type FilterValue,
} from "./filter";
import { isIsoDate } from "./cell-values";

export type FilterEvalContext = {
  /** The kind of each field the filter may name. */
  kinds: ReadonlyMap<string, FilterKind>;
  /** The reader's time zone, for relative dates and a time's day. */
  timeZone: string;
  /** The reader's id, for `me`. */
  me?: string;
  /** Now, for tests; the clock otherwise. */
  now?: Date;
};

/**
 * Whether `values` pass `group`: null when no condition applies (each is
 * blank, or names a field the context does not know, or an operator its
 * kind does not take), which constrains nothing.
 */
export function evaluateFilter(
  group: FilterGroup,
  values: Readonly<Record<string, unknown>>,
  context: FilterEvalContext,
): boolean | null {
  const results = group.conditions
    .map((node) =>
      isFilterGroup(node)
        ? evaluateFilter(node, values, context)
        : evaluateCondition(node, values, context),
    )
    .filter((result): result is boolean => result !== null);
  if (results.length === 0) return null;
  return group.conjunction === "and"
    ? results.every(Boolean)
    : results.some(Boolean);
}

/** One condition: null when it cannot apply, as the compiler leaves it out. */
export function evaluateCondition(
  condition: FilterCondition,
  values: Readonly<Record<string, unknown>>,
  context: FilterEvalContext,
): boolean | null {
  const kind = context.kinds.get(condition.column);
  if (!kind || !OPERATORS_BY_KIND[kind].includes(condition.op)) return null;
  const x = values[condition.column];
  const { op, value } = condition;
  if (op === "is_empty") return isEmpty(x, kind);
  if (op === "is_not_empty") return !isEmpty(x, kind);
  switch (kind) {
    case "boolean":
      return typeof value === "boolean" ? (x === true) === value : null;
    case "text":
      return textCondition(op, textOf(x), value, context.me);
    case "number":
      return numberCondition(op, numberOf(x), value);
    case "date":
    case "datetime":
      return dateCondition(op, dayOf(x, context.timeZone), value, context);
    case "user": {
      const items = listValue(value, context.me);
      if (!items) return null;
      const id = Array.isArray(x) ? (x[0] as unknown) : x;
      const found = typeof id === "string" && items.includes(id);
      return op === "is" || op === "is_any_of" ? found : !found;
    }
    case "options":
    case "users":
    case "array":
      return listCondition(op, x, value, context.me);
    default:
      return null;
  }
}

function isEmpty(x: unknown, kind: FilterKind): boolean {
  if (x === null || x === undefined) return true;
  if (kind === "text") return x === "";
  if (Array.isArray(x)) return x.length === 0;
  return x === "";
}

function textOf(x: unknown): string | null {
  if (typeof x === "string") return x;
  if (typeof x === "number") return String(x);
  return null;
}

function textValue(value: FilterValue | undefined): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number") return String(value);
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
  if (!items || items.length === 0) return undefined;
  return items.map((item) => (item === "me" && me ? me : item));
}

function textCondition(
  op: FilterCondition["op"],
  x: string | null,
  value: FilterValue | undefined,
  me: string | undefined,
): boolean | null {
  if (op === "is_any_of" || op === "is_none_of") {
    const items = listValue(value, me);
    if (!items) return null;
    const found = x !== null && items.includes(x);
    return op === "is_any_of" ? found : !found;
  }
  const text = textValue(value);
  if (text === undefined) return null;
  // Text compares without case, as the compiled filter does.
  const [a, b] = [x?.toLowerCase() ?? null, text.toLowerCase()];
  switch (op) {
    case "is":
      return a === b;
    case "is_not":
      return a !== b;
    case "contains":
      return a !== null && a.includes(b);
    case "not_contains":
      return !(a ?? "").includes(b);
    case "starts_with":
      return a !== null && a.startsWith(b);
    case "ends_with":
      return a !== null && a.endsWith(b);
    default:
      return null;
  }
}

function numberOf(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string" && x.trim() !== "") {
    const number = Number(x.trim());
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function numberCondition(
  op: FilterCondition["op"],
  x: number | null,
  value: FilterValue | undefined,
): boolean | null {
  if (op === "is_between") {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [from, to] = [numberOf(value[0]), numberOf(value[1])];
    if (from === null && to === null) return null;
    return (
      x !== null && (from === null || x >= from) && (to === null || x <= to)
    );
  }
  const n = numberOf(value);
  if (n === null) return null;
  if (op === "is_not") return x === null || x !== n;
  if (x === null) return false;
  switch (op) {
    case "is":
      return x === n;
    case "gt":
      return x > n;
    case "gte":
      return x >= n;
    case "lt":
      return x < n;
    case "lte":
      return x <= n;
    default:
      return null;
  }
}

/* Dates: ISO days (`YYYY-MM-DD`), which compare as text. */

/** The day of a date, or of an instant in the zone `timeZone`. */
function dayOf(x: unknown, timeZone: string): string | null {
  if (typeof x !== "string" || x.length < 10) return null;
  const day = x.slice(0, 10);
  if (!isIsoDate(day)) return null;
  // An instant with its zone (`Z`, `+02:00`) falls on its day in the
  // reader's zone; a wall-clock time (a form's input) is already there.
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(x)) {
    const instant = new Date(x);
    return Number.isNaN(instant.getTime()) ? null : localDay(instant, timeZone);
  }
  return day;
}

function localDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function toUtc(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function plusDays(day: string, days: number): string {
  const date = toUtc(day);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Months added as PostgreSQL adds them: a day past the month's end is its last. */
function plusMonths(day: string, months: number): string {
  const date = toUtc(day);
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1),
  );
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), last));
  return target.toISOString().slice(0, 10);
}

function startOf(day: string, unit: "week" | "month" | "year"): string {
  if (unit === "year") return `${day.slice(0, 4)}-01-01`;
  if (unit === "month") return `${day.slice(0, 7)}-01`;
  // Weeks start on Monday.
  const weekday = (toUtc(day).getUTCDay() + 6) % 7;
  return plusDays(day, -weekday);
}

type Range = { start: string; end: string };

/** The days a date filter's value names, `[start, end)`, as `dateRange` does. */
function dayRange(
  value: FilterValue | undefined,
  within: boolean,
  today: string,
): Range | undefined {
  let spec: DateFilterValue | undefined;
  if (typeof value === "string") {
    spec = isIsoDate(value.slice(0, 10))
      ? { mode: "exact", date: value.slice(0, 10) }
      : undefined;
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    spec = value;
  }
  if (!spec) return undefined;
  const days = spec.days ?? 0;
  const period = (unit: "week" | "month" | "year", offset: number): Range => {
    const first = startOf(today, unit);
    const start =
      offset === 0
        ? first
        : unit === "week"
          ? plusDays(first, offset * 7)
          : plusMonths(first, unit === "year" ? offset * 12 : offset);
    const end =
      unit === "week"
        ? plusDays(start, 7)
        : plusMonths(start, unit === "year" ? 12 : 1);
    return { start, end };
  };
  if (within) {
    switch (spec.mode) {
      case "past_week":
        return { start: plusDays(today, -7), end: plusDays(today, 1) };
      case "past_month":
        return { start: plusMonths(today, -1), end: plusDays(today, 1) };
      case "past_year":
        return { start: plusMonths(today, -12), end: plusDays(today, 1) };
      case "next_week":
        return { start: today, end: plusDays(today, 8) };
      case "next_month":
        return { start: today, end: plusDays(plusMonths(today, 1), 1) };
      case "next_year":
        return { start: today, end: plusDays(plusMonths(today, 12), 1) };
      case "past_days":
        return { start: plusDays(today, -days), end: plusDays(today, 1) };
      case "next_days":
        return { start: today, end: plusDays(today, days + 1) };
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
      return { start: today, end: plusDays(today, 1) };
    case "yesterday":
      return { start: plusDays(today, -1), end: today };
    case "tomorrow":
      return { start: plusDays(today, 1), end: plusDays(today, 2) };
    case "days_ago": {
      const start = plusDays(today, -days);
      return { start, end: plusDays(start, 1) };
    }
    case "days_from_now": {
      const start = plusDays(today, days);
      return { start, end: plusDays(start, 1) };
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
    case "exact":
      return spec.date && isIsoDate(spec.date)
        ? { start: spec.date, end: plusDays(spec.date, 1) }
        : undefined;
    default:
      return undefined;
  }
}

function dateCondition(
  op: FilterCondition["op"],
  day: string | null,
  value: FilterValue | undefined,
  context: FilterEvalContext,
): boolean | null {
  if (op === "is_between") {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const day10 = (end: string | undefined) => {
      const text = end?.slice(0, 10) ?? "";
      return isIsoDate(text) ? text : null;
    };
    const [from, to] = [day10(value[0]), day10(value[1])];
    if (!from && !to) return null;
    return day !== null && (!from || day >= from) && (!to || day <= to);
  }
  const today = localDay(context.now ?? new Date(), context.timeZone);
  const range = dayRange(value, op === "is_within", today);
  if (!range) return null;
  const inside = day !== null && day >= range.start && day < range.end;
  switch (op) {
    case "is":
    case "is_within":
      return inside;
    case "is_not":
      return !inside;
    case "is_before":
      return day !== null && day < range.start;
    case "is_after":
      return day !== null && day >= range.end;
    case "is_on_or_before":
      return day !== null && day < range.end;
    case "is_on_or_after":
      return day !== null && day >= range.start;
    default:
      return null;
  }
}

function listCondition(
  op: FilterCondition["op"],
  x: unknown,
  value: FilterValue | undefined,
  me: string | undefined,
): boolean | null {
  const have = Array.isArray(x)
    ? x.filter((item): item is string => typeof item === "string")
    : typeof x === "string" && x !== ""
      ? [x]
      : [];
  if (op === "contains" || op === "not_contains") {
    const text = textValue(value)?.toLowerCase();
    if (text === undefined) return null;
    const found = have.some((item) => item.toLowerCase().includes(text));
    return op === "contains" ? found : !found;
  }
  const items = listValue(value, me);
  if (!items) return null;
  switch (op) {
    case "has_any_of":
      return items.some((item) => have.includes(item));
    case "has_all_of":
      return items.every((item) => have.includes(item));
    case "has_none_of":
      return !items.some((item) => have.includes(item));
    case "is_exactly":
      return (
        items.every((item) => have.includes(item)) &&
        have.every((item) => items.includes(item))
      );
    default:
      return null;
  }
}
