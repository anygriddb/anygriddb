import type { ColumnConfig } from "../field-config";
import type { FieldType } from "../field-types";
import type { FilterGroup } from "../filter";

/**
 * How a link column reaches its rows. `forward` columns own the foreign
 * key (one-to-many) or the left side of the junction; `inverse` columns are
 * the other end of a two-way link.
 */
export type EngineRelation = {
  kind: "one_to_many" | "many_to_many";
  direction: "forward" | "inverse";
  /** Table whose rows this column lists. */
  targetTableId: string;
  /**
   * One-to-many: the foreign-key column as stored, on the table that holds
   * it: the forward side's own, or the target's for an inverse link.
   */
  fkColumn?: string;
  /** Many-to-many: the physical junction table. */
  junction?: string;
};

export type EngineColumn = {
  id: string;
  name: string;
  label: string;
  fieldType: FieldType;
  config: ColumnConfig;
  relation?: EngineRelation;
  /**
   * A client's column (ADR 0006): its name and type where it is stored. It
   * reads in the field's own SQL type, so every operator works on it.
   */
  physical?: PhysicalColumn;
};

export type PhysicalColumn = {
  name: string;
  /** The engine's own name of the type, such as `numeric(12,2)`. */
  type: string;
  /** The source's time zone: a date and time without one is read in it. */
  zone: string;
  /**
   * A field AnyGridDB added (ADR 0032): stored in the table's side table,
   * in the side schema of the client's database, not in the client's.
   */
  side?: boolean;
  /**
   * A field AnyGridDB added with no side schema (ADR 0046): values live
   * in the control plane and are merged after the client read.
   */
  controlPlane?: boolean;
  /**
   * Not in the copy a synced table reads (ADR 0034): a field added since
   * the last refresh. It reads empty until the next one.
   */
  missing?: boolean;
};

/**
 * Where a table's rows live (ADR 0002): a physical table in AnyGridDB's
 * database, or a table or view in a client's database.
 */
export type TableStorage = "native" | "external";

/** A table or view of a client's database (ADR 0006). */
export type ExternalRelation = {
  sourceId: string;
  /** The engine the source runs, whose SQL reads compile to. */
  dialect: "postgres" | "mysql" | "mariadb" | "sqlserver";
  schema: string;
  name: string;
  /** The primary key's columns, as stored; empty for a view without one. */
  key: readonly string[];
  /** The side table of the fields AnyGridDB added, keyed like this one. */
  side?: { schema: string; name: string };
  /**
   * Read from its copy in AnyGridDB's database (ADR 0034): `schema` and
   * `name` are the copy's, `dialect` PostgreSQL, and a row's id is the one
   * the client's table gave it, kept in `ag_id`.
   */
  synced?: boolean;
};

export type EngineTable = {
  id: string;
  storage: TableStorage;
  physicalName: string;
  /** Set for an external table: where its rows are, and their key. */
  external?: ExternalRelation;
  columns: readonly EngineColumn[];
  /** Column whose value labels this table's rows in links. */
  primaryColumn?: string;
  /**
   * The version of the server that reads the rows (`16.4` is `[16, 4]`):
   * the client's for a table read live, AnyGridDB's otherwise. Unknown
   * when absent, and then taken as recent enough.
   */
  serverVersion?: readonly number[];
};

/**
 * Field and row rules of one reader. Absent for a privileged read (an owner,
 * or a reader without rules). The read engine enforces it everywhere a table
 * is read: the page, formulas, links, lookups, rollups, filters, sorts,
 * search, groups, and aggregates.
 */
export type EngineAccess = {
  /** True when the reader may not see the field: its value compiles to empty. */
  hidden: (tableId: string, columnName: string) => boolean;
  /** True when the reader may see the field but not change it. */
  readOnly: (tableId: string, columnName: string) => boolean;
  /** Rows of the table the reader may see, or undefined for every row. */
  rowFilter: (tableId: string) => FilterGroup | undefined;
  /** The reader, substituted for `me` in row filters. */
  me?: string;
};

export type EngineCatalog = {
  table: EngineTable;
  /** Every table reachable through this table's links, keyed by id. */
  tables: ReadonlyMap<string, EngineTable>;
  /** False for a table the caller cannot read: its values compile to empty. */
  readable: (tableId: string) => boolean;
  access?: EngineAccess;
};

export function findColumn(
  table: EngineTable,
  name: string,
): EngineColumn | undefined {
  return table.columns.find((column) => column.name === name);
}
