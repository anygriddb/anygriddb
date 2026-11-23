/**
 * What the catalog's procedures share with each other, with the public
 * API, and with shares: how a table's fields read from outside, and where
 * a failed announcement is logged.
 */
import {
  isComputedType,
  describeColumns,
  type EngineCatalog,
  formatFormula,
  instantDigitsOf,
  linkColumnConfig,
  readerColumnConfig,
  selectOptionNames,
} from "@anygriddb/core";
import {
  columnConfig,
  lookupCatalog,
  sortColumns,
  type CatalogLookup,
  type CatalogRows,
} from "../data/engine.js";
import type { Context } from "./context.js";

/** Public shape of a table's columns, with the kind each one reads as. */
export function publicColumns(
  engine: EngineCatalog,
  rows: CatalogRows,
  lookup: CatalogLookup = lookupCatalog(rows),
) {
  const kinds = new Map(
    describeColumns(engine).map((column) => [column.name, column]),
  );
  const access = engine.access;
  // A field the reader may not see is left out, as if it did not exist.
  const own = sortColumns(
    (lookup.columnsOf.get(engine.table.id) ?? []).filter(
      (column) => !access?.hidden(engine.table.id, column.name),
    ),
  );
  const engineById = new Map(engine.table.columns.map((c) => [c.id, c]));
  const engineByName = new Map(engine.table.columns.map((c) => [c.name, c]));
  const refs = own.map((column) => ({
    name: column.name,
    label: column.label,
  }));
  const tableRow = lookup.tables.get(engine.table.id);
  /**
   * A client's inverse link writes the other table's foreign key: it takes
   * changes when that table takes edits and its key may be written.
   */
  const inverseWritable = (name: string): boolean => {
    const relation = engineByName.get(name)?.relation;
    if (
      relation?.direction !== "inverse" ||
      relation.kind !== "one_to_many" ||
      !relation.fkColumn
    ) {
      return false;
    }
    const target = lookup.tables.get(relation.targetTableId);
    const key = lookup.columnsOf
      .get(relation.targetTableId)
      ?.find((item) => item.physicalName === relation.fkColumn);
    return Boolean(
      target?.externalUpdate &&
      key?.externalWritable &&
      !engine.tables.get(relation.targetTableId)?.external?.synced,
    );
  };
  return own.map((column) => {
    const stored = columnConfig(column);
    const described = kinds.get(column.name);
    const relation = lookup.relations.get(column.id);
    const engineColumn = engineById.get(column.id);
    // The table a link or a lookup reads: its rules decide what its
    // settings may say.
    const linked =
      engineColumn?.relation?.targetTableId ??
      (stored.relation === undefined
        ? undefined
        : engineByName.get(stored.relation)?.relation?.targetTableId);
    const config = readerColumnConfig(stored, {
      hidden: (name) => access?.hidden(engine.table.id, name) ?? false,
      linkedHidden: (name) =>
        linked !== undefined &&
        (!engine.readable(linked) || (access?.hidden(linked, name) ?? false)),
    });
    return {
      id: column.id,
      name: column.name,
      label: column.label,
      description: column.description,
      fieldType: column.fieldType,
      position: column.position,
      isPrimary: column.isPrimary,
      isUnique: column.isUnique,
      requireReason: column.requireReason,
      required: column.required,
      /**
       * `read` when a field rule lets the reader see but not change it, or
       * when a client's column takes no writes: a type AnyGridDB cannot
       * write back exactly, or a right the source's account lacks.
       */
      access:
        access?.readOnly(engine.table.id, column.name) ||
        // A synced table is a copy (ADR 0034): nothing is written there.
        (engine.table.external?.synced && !isComputedType(column.fieldType)) ||
        (engine.table.storage === "external" &&
          !isComputedType(column.fieldType) &&
          !column.externalSide &&
          !inverseWritable(column.name) &&
          (!column.externalWritable || !tableRow?.externalUpdate))
          ? ("read" as const)
          : ("write" as const),
      /** A field AnyGridDB added to a client's table (ADR 0032). */
      side: column.externalSide,
      /**
       * Enrichment without a side schema: values in the control plane
       * (ADR 0046). Sort and group are refused; filters are limited.
       */
      controlPlane:
        engineByName.get(column.name)?.physical?.controlPlane === true,
      /**
       * A client's column a new row may fill: its type is written back
       * exactly. Native fields follow `access`.
       */
      insertable:
        engine.table.storage === "external"
          ? !engine.table.external?.synced &&
            column.externalInsertable &&
            !access?.readOnly(engine.table.id, column.name)
          : !access?.readOnly(engine.table.id, column.name),
      config,
      /** The decimals of a second its column keeps, past the usual six. */
      instantDigits: instantDigitsOf(engineByName.get(column.name)?.physical),
      kind: described?.kind ?? "text",
      elem: described?.elem ?? null,
      error: described?.error ?? null,
      /** What the client's engine computes differently (ADR 0005). */
      limits: described?.limits ?? [],
      /** A lookup's or a rollup's durations: the format to show them in. */
      duration: described?.duration ?? null,
      noGroup: described?.noGroup === true,
      noCompare: described?.noCompare === true,
      formulaSource: config.expr ? formatFormula(config.expr, refs) : null,
      relation: relation
        ? {
            kind: relation.kind,
            targetTableId: relation.toTableId,
            direction: engineColumn?.relation?.direction ?? "forward",
            inverseColumnId: relation.inverseColumnId,
          }
        : null,
      /** Pre-v2 fields, kept until every client reads `config`. */
      formula: config.expr ?? null,
      options:
        column.fieldType === "single_select" ||
        column.fieldType === "multi_select"
          ? selectOptionNames(config)
          : null,
      computed:
        (column.fieldType === "lookup" || column.fieldType === "rollup") &&
        config.relation !== undefined
          ? {
              relation: config.relation ?? "",
              target: config.target ?? "",
              fn: config.fn ?? null,
            }
          : null,
    };
  });
}

/**
 * The fields a public link shows, as anyone who opens it reads them: how
 * their values are drawn, and nothing of what they compute from.
 */
export function linkColumns(
  engine: EngineCatalog,
  rows: CatalogRows,
  fields: readonly string[],
) {
  return publicColumns(engine, rows)
    .filter((column) => fields.includes(column.name))
    .map((column) => ({
      ...column,
      config: linkColumnConfig(column.config),
      formulaSource: null,
      formula: null,
      computed: null,
    }));
}

export function logPublish(ctx: Context): (error: unknown) => void {
  return (error) => {
    ctx.req.log.error({ err: error }, "realtime publish failed");
  };
}
