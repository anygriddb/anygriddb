import {
  AppError,
  buildDropColumn,
  buildDropTable,
  buildNonNullValues,
  MAX_READ_LIMIT,
} from "@anygriddb/core";
import { runStatement, type Database } from "@anygriddb/db";
import { deleteFiles, type FileStore } from "../files/index.js";
import { runRows, withAudit } from "./audit-context.js";

/** Attachment keys held by some columns of a table, to delete their files. */
export async function columnAttachmentKeys(
  db: Database,
  physicalName: string,
  columnNames: readonly string[],
): Promise<string[]> {
  const keys: string[] = [];
  for (const name of columnNames) {
    let offset = 0;
    for (;;) {
      const statement = buildNonNullValues({
        table: physicalName,
        column: name,
        limit: MAX_READ_LIMIT,
        offset,
      });
      const result = await runStatement(db, statement);
      if (result.length === 0) break;
      for (const row of result) {
        const value: unknown = row.value;
        for (const key of Array.isArray(value) ? value : [value]) {
          if (typeof key === "string") {
            keys.push(key);
          }
        }
      }
      offset += result.length;
      if (result.length < MAX_READ_LIMIT) break;
    }
  }
  return keys;
}

export async function removeTable(
  db: Database,
  files: FileStore,
  userId: string,
  tableId: string,
  onAttachmentError: (error: unknown) => void,
): Promise<void> {
  const table = await db
    .selectFrom("dataTables")
    .selectAll()
    .where("id", "=", tableId)
    .executeTakeFirst();
  if (!table) {
    throw new AppError("no_row");
  }
  const columnRows = await db
    .selectFrom("dataColumns")
    .selectAll()
    .where("tableId", "=", table.id)
    .execute();
  const keys = await columnAttachmentKeys(
    db,
    table.physicalName,
    columnRows
      .filter((column) => column.fieldType === "attachment")
      .map((column) => column.name),
  );

  const incoming = await db
    .selectFrom("relations as r")
    .innerJoin("dataColumns as c", "c.id", "r.fromColumnId")
    .innerJoin("dataTables as t", "t.id", "c.tableId")
    .select([
      "r.kind",
      "r.junctionName",
      "c.id as columnId",
      "c.name as columnName",
      "c.tableId as sourceTableId",
      "t.physicalName as sourcePhysical",
      "t.storage as sourceStorage",
    ])
    .where("r.toTableId", "=", table.id)
    .execute();
  const outgoing = await db
    .selectFrom("relations as r")
    .innerJoin("dataColumns as c", "c.id", "r.fromColumnId")
    .select("r.junctionName")
    .where("c.tableId", "=", table.id)
    .execute();

  await withAudit(db, { userId, tableId: table.id }, async (tx) => {
    for (const link of incoming) {
      if (link.junctionName) {
        await runRows(tx, buildDropTable(link.junctionName));
      }
      if (link.sourceTableId === table.id) {
        continue;
      }
      // A client's table has no column of AnyGridDB's to drop.
      if (link.kind === "one_to_many" && link.sourceStorage === "native") {
        await runRows(
          tx,
          buildDropColumn({
            table: link.sourcePhysical,
            column: link.columnName,
          }),
        );
      }
      await tx
        .deleteFrom("dataColumns")
        .where("id", "=", link.columnId)
        .execute();
    }

    for (const link of outgoing) {
      if (!link.junctionName) {
        continue;
      }
      await runRows(tx, buildDropTable(link.junctionName));
    }

    // A client's table stays in the client's database: only the catalog
    // forgets it.
    if (table.storage === "native") {
      await runRows(tx, buildDropTable(table.physicalName));
    }
    await tx
      .deleteFrom("roleBindings")
      .where("scope", "=", "table")
      .where("scopeId", "=", table.id)
      .execute();
    await tx.deleteFrom("dataTables").where("id", "=", table.id).execute();
  });
  await deleteFiles(files, keys, onAttachmentError);
}

export async function removeBase(
  db: Database,
  files: FileStore,
  userId: string,
  baseId: string,
  onAttachmentError: (error: unknown) => void,
): Promise<void> {
  const tableRows = await db
    .selectFrom("dataTables")
    .select("id")
    .where("baseId", "=", baseId)
    .execute();
  for (const table of tableRows) {
    await removeTable(db, files, userId, table.id, onAttachmentError);
  }
  await withAudit(db, { userId }, async (tx) => {
    await tx
      .deleteFrom("roleBindings")
      .where("scope", "=", "base")
      .where("scopeId", "=", baseId)
      .execute();
    await tx.deleteFrom("bases").where("id", "=", baseId).execute();
  });
}
