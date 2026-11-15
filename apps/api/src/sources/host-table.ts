/**
 * Tables a base creates in the SQL schema it owns (ADR 0090). They are
 * external tables whose schema AnyGridDB made: a field that stores a
 * value is a column there, typed as a side column is (ADR 0032), and the
 * rows are read and written as a client's rows are. A table that already
 * existed at the client is never created, changed, or dropped here.
 *
 * The source is changed outside the catalog's transaction, so a network
 * call never holds that transaction open; when the catalog then refuses
 * the change, what was made in the source is taken back.
 */
import { randomBytes } from "node:crypto";
import {
  AppError,
  buildCreateHome,
  buildDropHome,
  buildDropHomeColumn,
  buildDropHomeTable,
  buildHomeColumn,
  buildHomeColumnExists,
  buildHomeTable,
  homeColumnType,
  homePhysicalName,
  homeSchemaName,
  homeTableName,
  isHomeDialect,
  isSideFieldType,
  madeNames,
  type ColumnConfig,
  type FieldType,
  type HomeColumn,
  type HomeDialect,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { withAudit, type AuditTx } from "../data/audit-context.js";
import { sourcePools } from "./pools.js";

/** A field as `planColumn` made it. */
export type HostedField = {
  name: string;
  label: string;
  fieldType: FieldType;
  description: string | null;
  requireReason: boolean;
  config: ColumnConfig;
};

/** Fields the catalog computes: they have no column anywhere. */
const CATALOG_ONLY = new Set<FieldType>(["formula", "button", "row_id"]);

/** The column a field gets in the source, or none; refused when it cannot. */
function homeColumn(field: HostedField): HomeColumn | null {
  if (CATALOG_ONLY.has(field.fieldType)) return null;
  if (!isSideFieldType(field.fieldType)) {
    throw new AppError("source_home_field_type", field.fieldType);
  }
  return { name: field.name, fieldType: field.fieldType };
}

async function homeDialect(
  db: Database,
  sourceId: string,
): Promise<HomeDialect> {
  const source = await db
    .selectFrom("sources")
    .select("engine")
    .where("id", "=", sourceId)
    .executeTakeFirst();
  if (!source || !isHomeDialect(source.engine)) {
    throw new AppError("invalid_arguments");
  }
  return source.engine;
}

async function inSource(
  sourceId: string,
  statements: ReadonlyArray<{ text: string; values: unknown[] }>,
): Promise<void> {
  await sourcePools().write(sourceId, async (run) => {
    for (const statement of statements) await run(statement);
    return [];
  });
}

/** Creates the schema and records it on the base. */
export async function attachHome(
  db: Database,
  userId: string,
  baseId: string,
  sourceId: string,
): Promise<void> {
  const dialect = await homeDialect(db, sourceId);
  const schema = homeSchemaName(baseId);
  await inSource(sourceId, [buildCreateHome(dialect, schema)]);
  try {
    await withAudit(db, { userId, source: "web" }, async (tx) => {
      await tx
        .updateTable("bases")
        .set({ homeSourceId: sourceId, homeSchema: schema })
        .where("id", "=", baseId)
        .execute();
    });
  } catch (error) {
    await inSource(sourceId, [buildDropHome(dialect, schema)]).catch(
      () => undefined,
    );
    throw error;
  }
}

/**
 * Drops the schema a base owns, with whatever is in it, once an
 * administrator typed its name. A schema already gone is success.
 */
export async function dropHostedSchema(
  db: Database,
  baseId: string,
  schemaName: string,
): Promise<void> {
  const base = await db
    .selectFrom("bases")
    .select(["homeSourceId", "homeSchema"])
    .where("id", "=", baseId)
    .executeTakeFirst();
  if (!base?.homeSourceId || base.homeSchema !== schemaName) {
    throw new AppError("invalid_arguments");
  }
  const dialect = await homeDialect(db, base.homeSourceId);
  await inSource(base.homeSourceId, [buildDropHome(dialect, schemaName)]);
}

/** Creates the table in the base's schema and registers it. */
export async function createHostedTable(
  db: Database,
  userId: string,
  input: {
    baseId: string;
    name: string;
    description?: string;
    fields: readonly HostedField[];
    primaryIndex: number;
    viewName?: string;
    sourceId: string;
    schema: string;
  },
): Promise<{ id: string }> {
  const dialect = await homeDialect(db, input.sourceId);
  const columns = input.fields.map(homeColumn);
  const externalName = homeTableName(randomBytes(13).toString("hex"));
  await inSource(input.sourceId, [
    buildHomeTable(
      dialect,
      input.schema,
      externalName,
      columns.filter((column) => column !== null),
    ),
  ]);
  try {
    return await withAudit(db, { userId, source: "web" }, async (tx) => {
      const counted = await tx
        .selectFrom("dataTables")
        .select(sql<number>`count(*)::int`.as("count"))
        .where("baseId", "=", input.baseId)
        .where("folderId", "is", null)
        .where("deletedAt", "is", null)
        .executeTakeFirst();
      const table = await tx
        .insertInto("dataTables")
        .values({
          baseId: input.baseId,
          name: input.name,
          description: input.description ?? null,
          physicalName: homePhysicalName(randomBytes(16).toString("hex")),
          storage: "external",
          sourceId: input.sourceId,
          externalSchema: input.schema,
          externalName,
          externalKey: ["id"],
          externalUpdate: true,
          externalInsert: true,
          externalDelete: true,
          position: counted?.count ?? 0,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      // The identity the source draws: shown, never written.
      await tx
        .insertInto("dataColumns")
        .values({
          tableId: table.id,
          name: "f_id",
          label: "id",
          physicalName: "id",
          externalType: "bigint",
          externalWritable: false,
          externalInsertable: false,
          fieldType: "number",
          config: {},
          position: 0,
          isPrimary: input.primaryIndex < 0,
        })
        .execute();
      for (const [index, field] of input.fields.entries()) {
        await insertField(
          tx,
          table.id,
          dialect,
          field,
          columns[index] ?? null,
          {
            position: index + 1,
            isPrimary: index === input.primaryIndex,
          },
        );
      }
      await tx
        .insertInto("views")
        .values({
          tableId: table.id,
          name: input.viewName ?? madeNames().grid,
          viewType: "grid",
          config: {},
          position: 0,
        })
        .execute();
      return { id: table.id };
    });
  } catch (error) {
    await inSource(input.sourceId, [
      buildDropHomeTable(input.schema, externalName),
    ]).catch(() => undefined);
    throw error;
  }
}

async function insertField(
  tx: AuditTx,
  tableId: string,
  dialect: HomeDialect,
  field: HostedField,
  column: HomeColumn | null,
  place: { position: number; isPrimary: boolean },
): Promise<{ id: string; name: string }> {
  return tx
    .insertInto("dataColumns")
    .values({
      tableId,
      name: field.name,
      label: field.label,
      description: field.description,
      requireReason: field.requireReason,
      physicalName: field.name,
      fieldType: field.fieldType,
      config: field.config,
      position: place.position,
      isPrimary: place.isPrimary,
      ...(column
        ? {
            externalType: homeColumnType(dialect, column.fieldType),
            externalWritable: true,
            externalInsertable: true,
          }
        : {}),
    })
    .returning(["id", "name"])
    .executeTakeFirstOrThrow();
}

/** A table this product created in the source, as the catalog has it. */
type HostedTable = {
  id: string;
  sourceId: string | null;
  externalSchema: string | null;
  externalName: string | null;
};

function located(table: HostedTable): {
  sourceId: string;
  schema: string;
  name: string;
} {
  if (!table.sourceId || !table.externalSchema || !table.externalName) {
    throw new AppError("unknown_table");
  }
  return {
    sourceId: table.sourceId,
    schema: table.externalSchema,
    name: table.externalName,
  };
}

/** A field added to such a table: a column of it, unless it computes. */
export async function addHostedColumn(
  db: Database,
  userId: string,
  table: HostedTable,
  field: HostedField,
  position: number,
): Promise<{ id: string; name: string }> {
  const { sourceId, schema, name } = located(table);
  const dialect = await homeDialect(db, sourceId);
  const column = homeColumn(field);
  if (column) {
    await inSource(sourceId, [buildHomeColumn(dialect, schema, name, column)]);
  }
  try {
    return await withAudit(
      db,
      { userId, tableId: table.id, source: "web" },
      async (tx) => {
        await tx
          .updateTable("dataColumns")
          .set((eb) => ({ position: eb("position", "+", 1) }))
          .where("tableId", "=", table.id)
          .where("position", ">=", position)
          // Lists of linking rows sit at 10,000 and past.
          .where("position", "<", 10_000)
          .execute();
        return insertField(tx, table.id, dialect, field, column, {
          position,
          isPrimary: false,
        });
      },
    );
  } catch (error) {
    if (column) {
      await dropColumn(sourceId, dialect, schema, name, column.name).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

async function dropColumn(
  sourceId: string,
  dialect: HomeDialect,
  schema: string,
  table: string,
  column: string,
): Promise<void> {
  await sourcePools().write(sourceId, async (run) => {
    // MySQL has no `if exists` for a column.
    if (dialect === "mysql") {
      const found = await run(buildHomeColumnExists(schema, table, column));
      if (found.length === 0) return [];
    }
    await run(buildDropHomeColumn(dialect, schema, table, column));
    return [];
  });
}

/**
 * A field of such a table, deleted for good: its column goes too. Done
 * before the catalog forgets the field, so a purge that fails leaves
 * both, and the next purge tries again.
 */
export async function purgeHostedColumn(
  db: Database,
  table: HostedTable,
  column: { physicalName: string; externalType: string | null },
): Promise<void> {
  if (column.externalType === null) return;
  const { sourceId, schema, name } = located(table);
  const dialect = await homeDialect(db, sourceId);
  await dropColumn(sourceId, dialect, schema, name, column.physicalName);
}

/** Such a table, deleted for good: dropped from the schema too. */
export async function purgeHostedTable(table: HostedTable): Promise<void> {
  const { sourceId, schema, name } = located(table);
  await inSource(sourceId, [buildDropHomeTable(schema, name)]);
}
