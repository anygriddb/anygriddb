/**
 * Types a formula in the editor as the server will on save: parse, then
 * compile for types and engine limits against the editor's catalog,
 * discarding the SQL. The compiler owns the rules; the server still checks
 * again when the field is saved.
 */
import type { ColumnConfig } from "./field-config";
import type { FieldType } from "./field-types";
import {
  checkFormula,
  parseFormula,
  type FormulaProblem,
  type FormulaRef,
} from "./formula";
import { AppError } from "./errors";
import {
  MARIADB,
  MYSQL,
  POSTGRES,
  type DialectName,
  type SqlDialect,
} from "./query/dialect";
import { SQLSERVER } from "./query/dialect-sqlserver";
import type {
  EngineCatalog,
  EngineColumn,
  EngineRelation,
  EngineTable,
} from "./query/engine";
import {
  compileFormula,
  type ExprContext,
  type ScalarKind,
  type Typed,
} from "./query/expressions";
import type { SourceLimit } from "./query/limits";
import { SqlParams } from "./query/params";

/** One column the type checker may read, as the catalog already knows it. */
export type FormulaTypeColumn = {
  id: string;
  name: string;
  label: string;
  fieldType: FieldType;
  config: ColumnConfig;
  relation?: EngineRelation;
  /** Kept in AnyGridDB's database for a client's table (ADR 0046). */
  controlPlane?: boolean;
};

/** Tables and engine the formula is typed against. */
export type FormulaTypeContext = {
  tableId: string;
  columns: readonly FormulaTypeColumn[];
  /** Other tables reachable through links (lookups and rollups). */
  tables?: readonly {
    id: string;
    columns: readonly FormulaTypeColumn[];
  }[];
  engine?: DialectName;
  /** Column being edited: left out so its old formula cannot circularly type. */
  excludeColumn?: string;
};

export type FormulaTyped = {
  kind: Typed["kind"];
  elem?: ScalarKind;
  limits: SourceLimit[];
};

function dialectNamed(name: DialectName | undefined): SqlDialect {
  switch (name) {
    case "mysql":
      return MYSQL;
    case "mariadb":
      return MARIADB;
    case "sqlserver":
      return SQLSERVER;
    default:
      return POSTGRES;
  }
}

function engineColumn(column: FormulaTypeColumn): EngineColumn {
  return {
    id: column.id,
    name: column.name,
    label: column.label,
    fieldType: column.fieldType,
    config: column.config,
    ...(column.relation ? { relation: column.relation } : {}),
    ...(column.controlPlane
      ? {
          physical: {
            name: column.name,
            type: "text",
            zone: "UTC",
            controlPlane: true,
          },
        }
      : {}),
  };
}

function engineTable(
  id: string,
  columns: readonly FormulaTypeColumn[],
  engine: DialectName | undefined,
  excludeColumn: string | undefined,
): EngineTable {
  const own = columns
    .filter((column) => column.name !== excludeColumn)
    .map(engineColumn);
  if (!engine || engine === "postgres") {
    return {
      id,
      storage: "native",
      physicalName: `t_${id.replaceAll("-", "").slice(0, 12)}`,
      columns: own,
    };
  }
  return {
    id,
    storage: "external",
    physicalName: "t_typecheck",
    external: {
      sourceId: "typecheck",
      dialect: engine,
      schema: "public",
      name: "typecheck",
      key: ["id"],
    },
    columns: own,
  };
}

/** Builds the catalog compileFormula needs from the editor's snapshot. */
export function catalogForFormulaTypes(ctx: FormulaTypeContext): EngineCatalog {
  const table = engineTable(
    ctx.tableId,
    ctx.columns,
    ctx.engine,
    ctx.excludeColumn,
  );
  const tables = new Map<string, EngineTable>([[table.id, table]]);
  for (const other of ctx.tables ?? []) {
    if (other.id === table.id) continue;
    tables.set(
      other.id,
      engineTable(other.id, other.columns, ctx.engine, undefined),
    );
  }
  return {
    table,
    tables,
    readable: (tableId) => tables.has(tableId),
  };
}

/**
 * Types `source` without keeping the SQL. Returns a problem (parse or
 * type), or the result kind and any engine limits met while typing.
 */
export function typeFormula(
  source: string,
  refs: readonly FormulaRef[],
  ctx: FormulaTypeContext,
): FormulaProblem | FormulaTyped {
  const syntax = checkFormula(source, refs);
  if (syntax) return syntax;
  if (source.trim() === "") {
    return { code: "invalid_formula", from: 0, to: 0 };
  }
  try {
    const expr = parseFormula(source, refs);
    const catalog = catalogForFormulaTypes(ctx);
    const params = new SqlParams();
    const d = dialectNamed(ctx.engine);
    const limits = new Map<string, SourceLimit>();
    const exprCtx: ExprContext = {
      catalog,
      d,
      params,
      tz: d.textParam(params.bind("UTC")),
      aliases: { next: 0 },
      limits,
    };
    // Compiled as the field it will be, so what it reads is compiled as a
    // reference, the way the server compiles it when the field is saved.
    const self = `${catalog.table.id}:${ctx.excludeColumn ?? "\u0000new"}`;
    const typed = compileFormula(exprCtx, catalog.table, "r", expr, [self]);
    return {
      kind: typed.kind,
      ...(typed.kind === "array" ? { elem: typed.elem } : {}),
      limits: [...limits.values()],
    };
  } catch (error) {
    if (error instanceof AppError) {
      return {
        code: error.code,
        detail: error.detail,
        from: 0,
        to: source.length,
      };
    }
    throw error;
  }
}

/** Null when the formula parses and types; otherwise the first problem. */
export function checkFormulaTyped(
  source: string,
  refs: readonly FormulaRef[],
  ctx: FormulaTypeContext,
): FormulaProblem | null {
  const result = typeFormula(source, refs, ctx);
  if ("kind" in result) return null;
  return result;
}
