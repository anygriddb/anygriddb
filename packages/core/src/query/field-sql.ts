/**
 * How each field type is read and written in SQL: one entry per type, which
 * the compiler refuses to leave out (ADR 0138). What a type is (its storage
 * role, its kind, what it may be) is `FIELD_DEFINITIONS`; what its SQL does
 * on each engine is here, and the query builders read it rather than test
 * a type by its name.
 */
import {
  isWritableType,
  physicalSqlType,
  type FieldType,
} from "../field-types";
import type { DialectName } from "./dialect";
import type { EngineColumn } from "./engine";

/** How a read compiles a field. */
export type ReadRule =
  /** Its column, as its kind reads. */
  | "stored"
  /** Its expression. */
  | "formula"
  /** The values of a field of the rows it links. */
  | "lookup"
  /** One value worked out of the rows it links. */
  | "rollup"
  /** The labels of the rows it links. */
  | "links"
  /** The row's id, as text: AnyGridDB's uuid, or a client table's key. */
  | "row_id"
  /** Nothing: a button acts on its row and holds no value. */
  | "none";

/**
 * What the type's column holds, which each engine reads and writes it by.
 * A client's column is read into the field's own type (ADR 0006); null
 * when the type is never a column of its own on an engine.
 */
export type SqlValue =
  /** A text: MySQL's JSON or long text holding it is read as its text. */
  | "text"
  /** A JSON document, read and written as its text. */
  | "document"
  /** An exact decimal: a float holding one reads without its infinities. */
  | "number"
  /** A checkbox, which an engine may keep as a number or a bit. */
  | "flag"
  /** A day, which Oracle's DATE keeps with a time of day. */
  | "day"
  /** A date and time, read and compared in UTC. */
  | "instant"
  /** The client's own foreign key: the key of the row it links. */
  | "link";

/** The column of a client's side table that keeps the type, per engine. */
type SideColumns = Readonly<Record<DialectName, string>>;

export type FieldSql = {
  read: ReadRule;
  holds: SqlValue | null;
  /** AnyGridDB writes it to a client's column (ADR 0028). */
  writesToClient: boolean;
  /** Its choices: the field's options, or its table's states (ADR 0133). */
  choices: "options" | "states" | null;
  /** Kept in a client's side table, and as what (ADR 0032); null: never. */
  side: SideColumns | null;
  /**
   * Its numbers are seconds: a lookup of it, or a rollup that keeps its
   * unit, shows them as a duration.
   */
  seconds: boolean;
};

/** Text up to `size` characters on every engine but PostgreSQL's text. */
function textSide(size: number, sqlserver = `nvarchar(${String(size)})`) {
  return {
    postgres: "text",
    mysql: `varchar(${String(size)})`,
    mariadb: `varchar(${String(size)})`,
    sqlserver,
    oracle: `varchar2(${String(size)})`,
  } as const;
}

function stored<Side extends SideColumns | null>(
  holds: SqlValue | null,
  side: Side,
  extras: Partial<
    Pick<FieldSql, "writesToClient" | "choices" | "seconds">
  > = {},
) {
  return {
    read: "stored",
    holds,
    writesToClient: extras.writesToClient ?? holds !== null,
    choices: extras.choices ?? null,
    side,
    seconds: extras.seconds ?? false,
  } as const;
}

/** Nothing of the type is a column a client's table or a side table holds. */
function apart(read: ReadRule) {
  return {
    read,
    holds: null,
    writesToClient: false,
    choices: null,
    side: null,
    seconds: false,
  } as const;
}

/**
 * One entry per FieldType. A document is kept in the engine's JSON type
 * where every version AnyGridDB reaches has one (MariaDB's is a long text
 * it checks), and as the long text AnyGridDB checked itself on SQL Server
 * and Oracle.
 */
export const FIELD_SQL = {
  text: stored("text", textSide(1000)),
  long_text: stored("text", {
    postgres: "text",
    mysql: "mediumtext",
    mariadb: "mediumtext",
    sqlserver: "nvarchar(max)",
    oracle: "clob",
  }),
  number: stored("number", {
    postgres: "numeric",
    mysql: "decimal(38,10)",
    mariadb: "decimal(38,10)",
    sqlserver: "decimal(38,10)",
    oracle: "number(38,10)",
  }),
  boolean: stored("flag", {
    postgres: "boolean",
    mysql: "tinyint(1)",
    mariadb: "tinyint(1)",
    sqlserver: "bit",
    oracle: "number(1)",
  }),
  date: stored("day", {
    postgres: "date",
    mysql: "date",
    mariadb: "date",
    sqlserver: "date",
    oracle: "date",
  }),
  datetime: stored("instant", {
    postgres: "timestamp with time zone",
    mysql: "datetime(6)",
    mariadb: "datetime(6)",
    sqlserver: "datetime2(7)",
    oracle: "timestamp(6) with time zone",
  }),
  single_select: stored("text", textSide(200), { choices: "options" }),
  multi_select: stored(null, null, { choices: "options" }),
  email: stored("text", textSide(500)),
  url: stored("text", textSide(2000)),
  phone: stored("text", textSide(100)),
  color: stored("text", textSide(7, "varchar(7)")),
  place: stored("text", textSide(40, "varchar(40)")),
  json: stored("document", {
    postgres: "jsonb",
    mysql: "json",
    mariadb: "json",
    sqlserver: "nvarchar(max)",
    oracle: "clob",
  }),
  rating: stored("number", {
    postgres: "integer",
    mysql: "int",
    mariadb: "int",
    sqlserver: "int",
    oracle: "number(10)",
  }),
  // A client's duration is read, never written: its unit is AnyGridDB's.
  duration: stored("number", null, { writesToClient: false, seconds: true }),
  user: stored(null, null),
  attachment: stored(null, null),
  relation_one_to_many: {
    ...apart("links"),
    holds: "link",
    writesToClient: true,
  },
  relation_many_to_many: apart("links"),
  formula: apart("formula"),
  lookup: apart("lookup"),
  rollup: apart("rollup"),
  created_time: stored(null, null),
  last_modified_time: stored(null, null),
  created_by: stored(null, null),
  last_modified_by: stored(null, null),
  autonumber: stored(null, null),
  row_id: apart("row_id"),
  row_state: stored(null, null, { choices: "states" }),
  button: apart("none"),
} as const satisfies Record<FieldType, FieldSql>;

/** Field types a side table keeps: values AnyGridDB writes back exactly. */
export type SideFieldType = {
  [T in FieldType]: (typeof FIELD_SQL)[T]["side"] extends null ? never : T;
}[FieldType];

export function isSideFieldType(type: string): type is SideFieldType {
  return (
    Object.hasOwn(FIELD_SQL, type) && FIELD_SQL[type as FieldType].side !== null
  );
}

/** Side-table types, in the order of `FIELD_TYPES`. */
export const SIDE_FIELD_TYPES: readonly SideFieldType[] = (
  Object.keys(FIELD_SQL) as FieldType[]
).filter(isSideFieldType);

/** The SQL type a side column of `fieldType` has on an engine. */
export function sideColumnType(
  dialect: DialectName,
  fieldType: SideFieldType,
): string {
  return FIELD_SQL[fieldType].side[dialect];
}

/** What a field's column holds on an engine, or null. */
export function holdsOf(fieldType: FieldType): SqlValue | null {
  return FIELD_SQL[fieldType].holds;
}

/** A formula's expression; undefined for any other field. */
export function formulaExprOf(
  column: Pick<EngineColumn, "fieldType" | "config">,
): EngineColumn["config"]["expr"] {
  return FIELD_SQL[column.fieldType].read === "formula"
    ? column.config.expr
    : undefined;
}

/** A rollup's function; undefined for a lookup and any other field. */
export function rollupFnOf(
  column: Pick<EngineColumn, "fieldType" | "config">,
): EngineColumn["config"]["fn"] {
  return FIELD_SQL[column.fieldType].read === "rollup"
    ? column.config.fn
    : undefined;
}

/**
 * The SQL type AnyGridDB reads a field's value in: its own column's, a
 * document as its text, anything without a column of its own as text.
 */
export function readSqlType(fieldType: FieldType): string {
  return isWritableType(fieldType) && holdsOf(fieldType) !== "document"
    ? physicalSqlType(fieldType)
    : "text";
}
