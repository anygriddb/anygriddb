import { AppError } from "../errors";
import {
  hasPhysicalColumn,
  isWritableType,
  physicalSqlType,
  type FieldType,
} from "../field-types";
import { assertUserColumn, ownerCall } from "./ddl";
import { holdsOf } from "./field-sql";
import {
  assertIdentifier,
  quoteIdent,
  SqlParams,
  type ParameterizedSql,
} from "./params";

/**
 * The statements of a field's conversion. What each value becomes is the
 * cell's own rule (`convertCell`), applied by the server between a read
 * and a write of each batch: a conversion takes what a cell takes.
 */

function statement(text: string): ParameterizedSql {
  return { text, values: [] };
}

/**
 * For each type, the types all of whose values it already takes: the only
 * conversions that change the catalog and no row.
 */
const HOLDS: Partial<Record<FieldType, ReadonlySet<FieldType>>> = {
  text: new Set(["email", "url", "phone", "color", "place", "single_select"]),
  long_text: new Set([
    "text",
    "email",
    "url",
    "phone",
    "color",
    "place",
    "single_select",
  ]),
  number: new Set(["rating", "duration"]),
  duration: new Set(["rating"]),
};

/** True when every value of `from` is already a value of `to`. */
export function isMetadataConversion(from: FieldType, to: FieldType): boolean {
  return HOLDS[to]?.has(from) === true;
}

const CONVERTIBLE: ReadonlySet<FieldType> = new Set([
  "text",
  "long_text",
  "email",
  "url",
  "phone",
  "color",
  "place",
  "json",
  "single_select",
  "multi_select",
  "number",
  "rating",
  "duration",
  "boolean",
  "date",
  "datetime",
]);

export function isConvertible(from: FieldType, to: FieldType): boolean {
  return from !== to && CONVERTIBLE.has(from) && CONVERTIBLE.has(to);
}

/** True when both types keep their values in the same SQL type. */
export function isStoredAlike(from: FieldType, to: FieldType): boolean {
  return physicalSqlType(from) === physicalSqlType(to);
}

/**
 * What a conversion asks of a time zone. `required`: a day becomes an
 * instant or the reverse, and only a zone says which. `used`: a text
 * without an offset is read in it, and stays empty without one.
 */
export function conversionZone(
  from: FieldType,
  to: FieldType,
): "required" | "used" | "none" {
  if (!isConvertible(from, to)) return "none";
  if (
    (from === "date" && to === "datetime") ||
    (from === "datetime" && to === "date")
  ) {
    return "required";
  }
  return to === "datetime" ? "used" : "none";
}

function tempColumn(column: string): string {
  return `ag_tmp_${column}`.slice(0, 63);
}

/**
 * Marks the rows whose value a running job changes. No field's temporary
 * column can bear this name: a field's name never starts with `ag_`.
 */
const CHANGED = "ag_tmp_ag_changed";

function assertConversion(input: {
  table: string;
  column: string;
  from: FieldType;
  to: FieldType;
}): void {
  assertIdentifier(input.table, "table name");
  assertUserColumn(input.column);
  if (!hasPhysicalColumn(input.from) || !isWritableType(input.to)) {
    throw new AppError("invalid_conversion");
  }
}

/** The characters `String.prototype.trim` takes off. */
const SPACES =
  "E' \\t\\n\\r\\f\\x0b\\u00a0\\u1680\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'";

/** A stored value's text, spelled by the rule of its stored type. */
function asText(sqlType: string, value: string): string {
  switch (sqlType) {
    case "text":
      return value;
    case "text[]":
      return `nullif(array_to_string(${value}, ', '), '')`;
    case "numeric":
      return `trim_scale(${value})::text`;
    case "date":
      return `to_char(${value}, 'YYYY-MM-DD')`;
    case "timestamptz":
      // An instant keeps its fraction of a second, without trailing zeros.
      return `(regexp_replace(to_char(${value} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), '\\.?0+$', '') || 'Z')`;
    default:
      return `${value}::text`;
  }
}

/**
 * The next values of a field to convert, in id order, as `convertCell`
 * reads them. An instant becoming a day is read in the conversion's zone,
 * as a filter on that day reads it.
 */
export function buildConversionRead(input: {
  table: string;
  column: string;
  from: FieldType;
  to: FieldType;
  timeZone?: string;
  after: string | null;
  limit: number;
}): ParameterizedSql {
  assertConversion(input);
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new AppError("invalid_limit");
  }
  const column = quoteIdent(input.column);
  const fromSql = physicalSqlType(input.from);
  const params = new SqlParams();
  const after = params.bind(input.after);
  const limit = params.bind(input.limit);
  let value: string;
  if (fromSql === "timestamptz" && input.to === "date") {
    if (input.timeZone === undefined) {
      throw new AppError("conversion_needs_time_zone");
    }
    value = `to_char(${column} at time zone ${params.bind(input.timeZone)}::text, 'YYYY-MM-DD')`;
  } else {
    value =
      fromSql === "text[]" || fromSql === "boolean"
        ? column
        : asText(fromSql, column);
  }
  const instant =
    fromSql === "timestamptz"
      ? `, ${asText(fromSql, column)} as "instant"`
      : "";
  return {
    text: `select "id", ${value} as "value"${instant} from ${quoteIdent(input.table)} where ${column} is not null and (${after}::uuid is null or "id" > ${after}::uuid) order by "id" limit ${limit}::int`,
    values: params.values,
  };
}

/** A value of a JSON document in a field's stored type. Never raises. */
export function storedFromJson(fieldType: FieldType, json: string): string {
  const text = `(${json} #>> '{}')`;
  if (holdsOf(fieldType) === "link") return `${text}::uuid`;
  const sqlType = physicalSqlType(fieldType);
  switch (sqlType) {
    case "text":
      return text;
    case "text[]":
      return `(case when jsonb_typeof(${json}) = 'array' then array(select jsonb_array_elements_text(${json})) end)`;
    case "uuid[]":
      return `(case when jsonb_typeof(${json}) = 'array' then array(select i::uuid from jsonb_array_elements_text(${json}) i) end)`;
    default:
      // A document past what jsonb holds (an exponent of a million) passes
      // a parser and not the type.
      return `(case when pg_input_is_valid(${text}, '${sqlType}') then ${text}::${sqlType} end)`;
  }
}

/**
 * Writes converted values, in the field itself or beside it. A job also
 * marks the rows it changes, to stamp them once its switch is done.
 */
export function buildConversionWrite(input: {
  table: string;
  column: string;
  to: FieldType;
  beside: boolean;
  marks?: boolean;
  rows: ReadonlyArray<{ id: string; value: unknown; changed: boolean }>;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertUserColumn(input.column);
  const target = quoteIdent(
    input.beside ? tempColumn(input.column) : input.column,
  );
  const mark = input.marks ? `, ${quoteIdent(CHANGED)} = v."changed"` : "";
  return {
    text: `update ${quoteIdent(input.table)} u set ${target} = ${storedFromJson(input.to, `v."value"`)}${mark} from jsonb_to_recordset($1::text::jsonb) as v("id" uuid, "value" jsonb, "changed" boolean) where u."id" = v."id"`,
    values: [JSON.stringify(input.rows)],
  };
}

/** The column a conversion fills before it takes the field's place. */
export function buildConversionTempColumn(input: {
  table: string;
  column: string;
  to: FieldType;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertUserColumn(input.column);
  physicalSqlType(input.to);
  return ownerCall(
    "ag_conversion_add_column",
    input.table,
    input.column,
    input.to,
  );
}

/** The column where a job marks the rows it changes. */
export function buildConversionMarks(table: string): ParameterizedSql {
  assertIdentifier(table, "table name");
  return ownerCall("ag_conversion_add_marks", table);
}

/** The next marked rows, stamped by the trigger and unmarked. */
export function buildConversionStamp(input: {
  table: string;
  after: string | null;
  limit: number;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  const table = quoteIdent(input.table);
  const mark = quoteIdent(CHANGED);
  return {
    text: `with "batch" as materialized (select "id" from ${table} where ${mark} and ($1::uuid is null or "id" > $1::uuid) order by "id" limit $2::int), "done" as (update ${table} u set ${mark} = null from "batch" b where u."id" = b."id" returning 1) select (select count(*)::int from "done") as "read", (select "id" from "batch" order by "id" desc limit 1) as "last"`,
    values: [input.after, input.limit],
  };
}

/** The field's old column gone, the one filled for it takes its name. */
export function buildConversionSwitch(input: {
  table: string;
  column: string;
}): ParameterizedSql[] {
  assertIdentifier(input.table, "table name");
  assertUserColumn(input.column);
  return [ownerCall("ag_conversion_switch", input.table, input.column)];
}

/** Takes away the columns of a conversion that has ended, however it did. */
export function buildDropConversionColumns(input: {
  table: string;
  column: string;
}): ParameterizedSql[] {
  assertIdentifier(input.table, "table name");
  assertUserColumn(input.column);
  return [ownerCall("ag_conversion_drop_columns", input.table, input.column)];
}

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Makes a table read-only while the job converts one of its fields: a
 * write is refused unless it is the job's own, and the guard lets go by
 * itself once the job has ended, however it ended.
 */
export function buildConversionGuard(
  table: string,
  jobId: string,
): ParameterizedSql {
  assertIdentifier(table, "table name");
  if (!JOB_ID.test(jobId)) throw new AppError("invalid_job");
  return ownerCall("ag_conversion_guard", table, jobId);
}

export function buildDropConversionGuard(table: string): ParameterizedSql {
  assertIdentifier(table, "table name");
  return ownerCall("ag_conversion_drop_guard", table);
}

/** Holds off every write of a table, and no read, until the transaction ends. */
export function buildLockOutWriters(table: string): ParameterizedSql {
  assertIdentifier(table, "table name");
  return statement(
    `lock table ${quoteIdent(table)} in share row exclusive mode`,
  );
}

/**
 * Taken by a row write before it reads its fields' types: it waits for a
 * conversion under way, and none can start until it has written.
 */
export function buildLockForRowWrite(table: string): ParameterizedSql {
  assertIdentifier(table, "table name");
  return statement(`lock table ${quoteIdent(table)} in row exclusive mode`);
}

/** The unique index of the converted values, built before the switch. */
export function buildConversionUniqueIndex(input: {
  table: string;
  column: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertUserColumn(input.column);
  return ownerCall("ag_conversion_unique_index", input.table, input.column);
}

/** That index, under the name the field's own has. */
export function buildRenameConversionIndex(input: {
  table: string;
  column: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertUserColumn(input.column);
  return ownerCall("ag_conversion_rename_index", input.table, input.column);
}

/** How many rows a table has, counted no further than `limit`. */
export function buildCountRowsUpTo(
  table: string,
  limit: number,
): ParameterizedSql {
  assertIdentifier(table, "table name");
  return {
    text: `select count(*)::int as "count" from (select 1 from ${quoteIdent(table)} limit $1::int) s`,
    values: [limit],
  };
}

/** How many values a field holds. */
export function buildCountValues(input: {
  table: string;
  column: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertUserColumn(input.column);
  return statement(
    `select count(*)::int as "count" from ${quoteIdent(input.table)} where ${quoteIdent(input.column)} is not null`,
  );
}

/**
 * The names a new list field takes from a column's values: each value
 * whole, or each item of a text written as a list, read the way a cell
 * reads them. A name longer than an option's is none.
 */
export function buildConversionOptions(input: {
  table: string;
  column: string;
  from: FieldType;
  to: FieldType;
  limit: number;
}): ParameterizedSql {
  assertConversion(input);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
    throw new AppError("invalid_limit");
  }
  const column = quoteIdent(input.column);
  const fromSql = physicalSqlType(input.from);
  const items =
    fromSql === "text[]"
      ? `unnest(${column})`
      : input.to === "multi_select" &&
          fromSql === "text" &&
          input.from !== "single_select"
        ? `regexp_split_to_table(${column}, E'[,;\\n]')`
        : `(select ${asText(fromSql, column)})`;
  return {
    text: `select "value" from (select distinct btrim(i."value", ${SPACES}) as "value" from ${quoteIdent(input.table)} cross join lateral ${items} as i("value") where ${column} is not null) d where "value" <> '' and char_length("value") <= 80 order by 1 limit $1::int`,
    values: [input.limit],
  };
}
