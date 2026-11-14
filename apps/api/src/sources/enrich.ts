/**
 * Fields AnyGridDB adds to a client's table (ADRs 0006, 0032, 0046): a
 * status, notes, a date of its own. With a side schema they live in a side
 * table of the client's database, joined on read. Without one they live in
 * the control plane. The client's own table is never changed.
 */
import {
  AppError,
  buildSideColumn,
  buildSideTable,
  type EngineTable,
  type FieldType,
  isSideFieldType,
  sideColumnType,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { withAudit } from "../data/audit-context.js";
import { loadEngine, type TableRow } from "../data/engine.js";
import { oracleErrorNumber } from "./oracle.js";
import { firstSqlServerError } from "./sqlserver.js";
import { sourcePools } from "./pools.js";

/** The side table of an exposed table: a name only AnyGridDB uses. */
function sideTableName(tableId: string): string {
  return `ag_t_${tableId.replace(/-/g, "")}`;
}

/** A side column's name, apart from every client column's. */
function sideColumnName(field: string, taken: ReadonlySet<string>): string {
  let name = `ag_${field}`.slice(0, 60);
  for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1) {
    name = `ag_${field}`.slice(0, 56) + `_${String(suffix)}`;
  }
  return name;
}

function field(error: unknown, name: string): string | undefined {
  if (!error || typeof error !== "object" || !(name in error)) return undefined;
  const value = (error as Record<string, unknown>)[name];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

/** True when a side table or column was there already. */
export function alreadyThere(error: unknown): boolean {
  const first = firstSqlServerError(error);
  const oracle = oracleErrorNumber(error);
  return (
    field(error, "code") === "42P07" ||
    field(error, "code") === "42701" ||
    field(error, "errno") === "1050" ||
    field(error, "errno") === "1060" ||
    field(first, "number") === "2714" ||
    field(first, "number") === "2705" ||
    // ORA-00955 a name already used, ORA-01430 a column already there.
    oracle === 955 ||
    oracle === 1430
  );
}

/** What the client's database said about its side schema, plainly. */
export function sideError(error: unknown, schema: string): unknown {
  if (
    error instanceof AppError &&
    error.code !== "source_query_failed" &&
    error.code !== "source_write_denied"
  ) {
    return error;
  }
  const cause = error instanceof AppError ? error.cause : error;
  const first = firstSqlServerError(cause);
  const code = field(cause, "code");
  const errno = field(cause, "errno");
  const number = field(first, "number");
  const oracle = oracleErrorNumber(cause);
  // ORA-01918: no such account, which is a schema on Oracle.
  if (
    code === "3F000" ||
    errno === "1049" ||
    number === "2760" ||
    oracle === 1918
  ) {
    return new AppError("source_side_missing", schema, { cause: error });
  }
  // ORA-01031: no CREATE TABLE there; ORA-01950: no quota to store rows.
  if (
    code === "42501" ||
    errno === "1142" ||
    errno === "1044" ||
    number === "262" ||
    number === "1088" ||
    number === "15151" ||
    oracle === 1031 ||
    oracle === 1950
  ) {
    return new AppError("source_side_denied", schema, { cause: error });
  }
  return error;
}

type SideField = {
  name: string;
  label: string;
  description: string | null;
  fieldType: FieldType;
  config: Record<string, unknown>;
  requireReason: boolean;
};

/**
 * Adds a field to a client's table in its side table: the side table first
 * if it has none, then its column, in the client's database; then the
 * field in AnyGridDB's catalog. A side column left by a failure after the
 * DDL stays unused, and is taken again by its name.
 */
export async function addSideField(
  db: Database,
  userId: string,
  table: TableRow,
  planned: SideField,
  position: number,
): Promise<{ id: string; name: string }> {
  const sideType = planned.fieldType;
  if (!isSideFieldType(sideType)) {
    throw new AppError("external_table_schema");
  }
  if (!table.sourceId) throw new AppError("unknown_table");
  const source = await db
    .selectFrom("sources")
    .select(["engine", "sideSchema"])
    .where("id", "=", table.sourceId)
    .executeTakeFirstOrThrow();
  const { engine } = await loadEngine(db, table.id, () => true);
  const external = engine.table.external;
  if (!external || external.key.length === 0) {
    throw new AppError("external_table_no_key");
  }
  const schema = source.sideSchema;
  // No side schema: keep the field in AnyGridDB (ADR 0046).
  if (!schema) {
    return withAudit(
      db,
      { userId, tableId: table.id, source: "web" },
      async (tx) => {
        await tx
          .updateTable("dataColumns")
          .set((eb) => ({ position: eb("position", "+", 1) }))
          .where("tableId", "=", table.id)
          .where("position", ">=", position)
          .where("position", "<", 10_000)
          .execute();
        const taken = new Set(
          (
            await tx
              .selectFrom("dataColumns")
              .select("physicalName")
              .where("tableId", "=", table.id)
              .execute()
          ).map((row) => row.physicalName.toLowerCase()),
        );
        for (const key of external.key) taken.add(key.toLowerCase());
        const column = sideColumnName(planned.name, taken);
        return tx
          .insertInto("dataColumns")
          .values({
            tableId: table.id,
            name: planned.name,
            physicalName: column,
            fieldType: planned.fieldType,
            requireReason: planned.requireReason,
            config: planned.config,
            label: planned.label,
            description: planned.description,
            position,
            externalType: sideColumnType(external.dialect, sideType),
            externalWritable: true,
            externalInsertable: true,
            externalSide: true,
            externalControlPlane: true,
          })
          .returning(["id", "name"])
          .executeTakeFirstOrThrow();
      },
    );
  }
  const sideName = table.externalSide ?? sideTableName(table.id);
  const sided: EngineTable = {
    ...engine.table,
    external: { ...external, side: { schema, name: sideName } },
  };
  const taken = new Set(
    engine.table.columns.flatMap((column) =>
      column.physical ? [column.physical.name.toLowerCase()] : [],
    ),
  );
  for (const key of external.key) taken.add(key.toLowerCase());
  const column = sideColumnName(planned.name, taken);
  try {
    await sourcePools().write(table.sourceId, async (run) => {
      if (!table.externalSide) {
        await run(buildSideTable(sided)).catch((error: unknown) => {
          if (!alreadyThere(error)) throw error;
          return [];
        });
      }
      await run(buildSideColumn(sided, column, sideType)).catch(
        (error: unknown) => {
          if (!alreadyThere(error)) throw error;
          return [];
        },
      );
    });
  } catch (error) {
    throw sideError(error, schema);
  }
  return withAudit(
    db,
    { userId, tableId: table.id, source: "web" },
    async (tx) => {
      if (!table.externalSide) {
        await tx
          .updateTable("dataTables")
          .set({ externalSide: sideName })
          .where("id", "=", table.id)
          .execute();
      }
      await tx
        .updateTable("dataColumns")
        .set((eb) => ({ position: eb("position", "+", 1) }))
        .where("tableId", "=", table.id)
        .where("position", ">=", position)
        .where("position", "<", 10_000)
        .execute();
      const inserted = await tx
        .insertInto("dataColumns")
        .values({
          tableId: table.id,
          name: planned.name,
          physicalName: column,
          fieldType: planned.fieldType,
          requireReason: planned.requireReason,
          config: planned.config,
          label: planned.label,
          description: planned.description,
          position,
          externalType: sideColumnType(external.dialect, sideType),
          externalWritable: true,
          externalInsertable: true,
          externalSide: true,
        })
        .returning(["id", "name"])
        .executeTakeFirstOrThrow();
      return inserted;
    },
  );
}
