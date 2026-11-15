/**
 * Tables a base creates in the SQL schema it owns. They are external
 * tables whose schema AnyGridDB made, so a column added later is a
 * column of that table. A table that already existed at the client is
 * never created here.
 */
import { randomBytes } from "node:crypto";
import {
  AppError,
  deriveColumnName,
  hasPhysicalColumn,
  isCopySourceEngine,
  type ColumnDefinition,
  type FieldType,
  type SqlSourceEngine,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { withAudit } from "../data/audit-context.js";
import {
  addHomeColumnSql,
  createHomeSql,
  dropHomeColumnSql,
  createHomeTableSql,
  dropHomeSql,
  dropHomeTableSql,
  homeSchemaName,
  homeTableName,
} from "./host-sql.js";
import { sourcePools } from "./pools.js";

const HOSTED = new Set<SqlSourceEngine>([
  "postgres",
  "mysql",
  "mariadb",
  "sqlserver",
]);

function storedColumns(columns: readonly ColumnDefinition[]): Array<{
  name: string;
  label: string;
  fieldType: FieldType;
  config: Record<string, unknown>;
}> {
  // `id` is the row's key, projected under that name. The field that shows
  // it takes another name, as a client's own `id` column does.
  const taken = new Set<string>(["id", "f_id"]);
  const stored: Array<{
    name: string;
    label: string;
    fieldType: FieldType;
    config: Record<string, unknown>;
  }> = [];
  for (const column of columns) {
    if (!hasPhysicalColumn(column.fieldType)) continue;
    const label = column.label ?? column.name ?? "Field";
    const name = deriveColumnName(column.name ?? label, taken);
    taken.add(name);
    stored.push({
      name,
      label,
      fieldType: column.fieldType,
      config: column.config ?? {},
    });
  }
  return stored;
}

/** Creates the schema and records it on the base. Oracle is refused. */
export async function attachHome(
  db: Database,
  userId: string,
  baseId: string,
  sourceId: string,
): Promise<void> {
  const source = await db
    .selectFrom("sources")
    .select(["id", "engine"])
    .where("id", "=", sourceId)
    .executeTakeFirst();
  if (
    !source ||
    isCopySourceEngine(source.engine) ||
    !HOSTED.has(source.engine)
  ) {
    throw new AppError("invalid_arguments");
  }
  const schema = homeSchemaName(baseId);
  const statement = createHomeSql(source.engine, schema);
  if (!statement) throw new AppError("invalid_arguments");
  await sourcePools().write(source.id, async (run) => {
    await run({ text: statement, values: [] });
    return [];
  });
  try {
    await withAudit(db, { userId, source: "web" }, async (tx) => {
      await tx
        .updateTable("bases")
        .set({ homeSourceId: source.id, homeSchema: schema })
        .where("id", "=", baseId)
        .execute();
    });
  } catch (error) {
    await dropSchema(source.id, source.engine, schema).catch(() => undefined);
    throw error;
  }
}

/** Removes the schema a base owns. A schema already gone is success. */
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
  const source = await db
    .selectFrom("sources")
    .select(["id", "engine"])
    .where("id", "=", base.homeSourceId)
    .executeTakeFirst();
  if (!source || !HOSTED.has(source.engine as SqlSourceEngine)) {
    throw new AppError("invalid_arguments");
  }
  const tables = await db
    .selectFrom("dataTables")
    .select("externalName")
    .where("baseId", "=", baseId)
    .where("externalSchema", "=", schemaName)
    .execute();
  await dropSchema(
    source.id,
    source.engine as SqlSourceEngine,
    schemaName,
    tables.flatMap((table) =>
      table.externalName && /^t[0-9a-f]{26}$/.test(table.externalName)
        ? [table.externalName]
        : [],
    ),
  );
}

async function dropSchema(
  sourceId: string,
  engine: SqlSourceEngine,
  schema: string,
  tables: readonly string[] = [],
): Promise<void> {
  const statement = dropHomeSql(engine, schema);
  if (!statement) return;
  await sourcePools().write(sourceId, async (run) => {
    for (const table of tables) {
      await run({
        text: dropHomeTableSql(engine, schema, table),
        values: [],
      });
    }
    await run({ text: statement, values: [] });
    return [];
  });
}

/** Creates the table in the base's schema and registers it. */
export async function createHostedTable(
  db: Database,
  userId: string,
  input: {
    baseId: string;
    name: string;
    description?: string;
    columns: readonly ColumnDefinition[];
    viewName?: string;
    sourceId: string;
    schema: string;
  },
): Promise<{ id: string }> {
  const source = await db
    .selectFrom("sources")
    .select(["id", "engine"])
    .where("id", "=", input.sourceId)
    .executeTakeFirst();
  if (!source || !HOSTED.has(source.engine as SqlSourceEngine)) {
    throw new AppError("invalid_arguments");
  }
  const engine = source.engine as SqlSourceEngine;
  const columns = storedColumns(input.columns);
  const externalName = homeTableName();
  const statement = createHomeTableSql(
    engine,
    input.schema,
    externalName,
    columns,
  );
  await sourcePools().write(source.id, async (run) => {
    await run({ text: statement, values: [] });
    return [];
  });
  try {
    return await withAudit(db, { userId, source: "web" }, async (tx) => {
      const counted = await tx
        .selectFrom("dataTables")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("baseId", "=", input.baseId)
        .where("deletedAt", "is", null)
        .executeTakeFirst();
      const table = await tx
        .insertInto("dataTables")
        .values({
          baseId: input.baseId,
          name: input.name,
          description: input.description ?? null,
          physicalName: `h_${randomBytes(16).toString("hex")}`,
          storage: "external",
          sourceId: source.id,
          externalSchema: input.schema,
          externalName,
          externalKey: ["id"],
          externalUpdate: true,
          externalInsert: true,
          externalDelete: true,
          position: Number(counted?.count ?? 0),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
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
          isPrimary: true,
        })
        .execute();
      for (const [index, column] of columns.entries()) {
        await tx
          .insertInto("dataColumns")
          .values({
            tableId: table.id,
            name: column.name,
            label: column.label,
            physicalName: column.name,
            externalType: column.fieldType,
            externalWritable: true,
            externalInsertable: true,
            fieldType: column.fieldType,
            config: column.config,
            position: index + 1,
          })
          .execute();
      }
      await tx
        .insertInto("views")
        .values({
          tableId: table.id,
          name: input.viewName ?? "Grid",
          viewType: "grid",
          config: {},
          position: 0,
        })
        .execute();
      return { id: table.id };
    });
  } catch (error) {
    await sourcePools()
      .write(source.id, async (run) => {
        await run({
          text: dropHomeTableSql(engine, input.schema, externalName),
          values: [],
        });
        return [];
      })
      .catch(() => undefined);
    throw error;
  }
}

/** A column on a table this product created in the source. */
export async function addHostedColumn(
  db: Database,
  userId: string,
  table: {
    id: string;
    sourceId: string | null;
    externalSchema: string | null;
    externalName: string | null;
  },
  column: {
    name: string;
    label: string;
    fieldType: FieldType;
    config: Record<string, unknown>;
  },
  position: number,
): Promise<{ id: string; name: string }> {
  if (!table.sourceId || !table.externalSchema || !table.externalName) {
    throw new AppError("unknown_table");
  }
  const source = await db
    .selectFrom("sources")
    .select("engine")
    .where("id", "=", table.sourceId)
    .executeTakeFirst();
  if (!source || !HOSTED.has(source.engine as SqlSourceEngine)) {
    throw new AppError("invalid_arguments");
  }
  const engine = source.engine as SqlSourceEngine;
  const schema = table.externalSchema;
  const externalName = table.externalName;
  const sourceId = table.sourceId;
  const statement = addHomeColumnSql(engine, schema, externalName, column);
  // The source is changed outside the catalog's transaction: a network
  // call must not hold that transaction open. If the catalog then
  // refuses the column, the source column is removed again.
  await sourcePools().write(sourceId, async (run) => {
    await run({ text: statement, values: [] });
    return [];
  });
  try {
    return await withAudit(
      db,
      { userId, tableId: table.id, source: "web" },
      async (tx) =>
        tx
          .insertInto("dataColumns")
          .values({
            tableId: table.id,
            name: column.name,
            label: column.label,
            physicalName: column.name,
            externalType: column.fieldType,
            externalWritable: true,
            externalInsertable: true,
            fieldType: column.fieldType,
            config: column.config,
            position,
          })
          .returning(["id", "name"])
          .executeTakeFirstOrThrow(),
    );
  } catch (error) {
    await sourcePools()
      .write(sourceId, async (run) => {
        await run({
          text: dropHomeColumnSql(engine, schema, externalName, column.name),
          values: [],
        });
        return [];
      })
      .catch(() => undefined);
    throw error;
  }
}
