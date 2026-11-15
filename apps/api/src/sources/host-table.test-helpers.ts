/**
 * One journey of a base held in a SQL source (ADR 0090), played against
 * each engine that can hold one: its schema, a table and its rows, a
 * field added and placed, a kind of field refused, a refresh that finds
 * nothing to change, then a field, the table, and the schema dropped.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sideColumnType, type HomeDialect } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { expect } from "vitest";
import { loadEngine } from "../data/engine.js";
import { readPage } from "../data/rows.js";
import { addColumn, insertBase, insertTable } from "../data/schema-ops.js";
import { purgeItem, trashColumn, trashTable } from "../data/trash.js";
import { DiskStore } from "../files/index.js";
import { createRows, loadRowScope, updateRows } from "../services/rows.js";
import { refreshExposedTable } from "./expose.js";
import { attachHome, dropHostedSchema } from "./host-table.js";
import type { SourceDeps } from "./sources.js";

export async function exerciseHostedBase(input: {
  deps: SourceDeps;
  admin: string;
  sourceId: string;
  dialect: HomeDialect;
  /** One value the source's own client prints for `query`. */
  scalar: (query: string) => Promise<string>;
}): Promise<void> {
  const { deps, admin, dialect, scalar } = input;
  const db: Database = deps.db;
  const quote = (name: string) =>
    dialect === "mysql" || dialect === "mariadb"
      ? `\`${name}\``
      : dialect === "sqlserver"
        ? `[${name}]`
        : `"${name}"`;
  const count = async (query: string) => Number(await scalar(query));

  const base = await insertBase(db, admin, { name: "Held" });
  await attachHome(db, admin, base.id, input.sourceId);
  const { homeSchema } = await db
    .selectFrom("bases")
    .select("homeSchema")
    .where("id", "=", base.id)
    .executeTakeFirstOrThrow();
  const schema = homeSchema ?? "";
  expect(schema).toMatch(/^ag[0-9a-f]{26}$/);
  expect(
    await count(
      `select count(*) from information_schema.schemata where schema_name = '${schema}'`,
    ),
  ).toBe(1);

  const created = await insertTable(db, admin, {
    baseId: base.id,
    name: "Lines",
    columns: [
      { label: "Note", fieldType: "text" },
      { label: "Price", fieldType: "number" },
    ],
  });
  const table = await db
    .selectFrom("dataTables")
    .selectAll()
    .where("id", "=", created.id)
    .executeTakeFirstOrThrow();
  expect(table.storage).toBe("external");
  expect(table.externalSchema).toBe(schema);
  const located = `${quote(schema)}.${quote(table.externalName ?? "")}`;
  const fields = await db
    .selectFrom("dataColumns")
    .select(["name", "label", "externalType", "isPrimary"])
    .where("tableId", "=", created.id)
    .orderBy("position")
    .execute();
  // The catalog records each column's own type, as for a client's table,
  // and the first text stays the row's title.
  expect(fields.map((field) => [field.label, field.externalType])).toEqual([
    ["id", "bigint"],
    ["Note", sideColumnType(dialect, "text")],
    ["Price", sideColumnType(dialect, "number")],
  ]);
  expect(fields.find((field) => field.isPrimary)?.label).toBe("Note");
  const note = fields[1]?.name ?? "";
  const price = fields[2]?.name ?? "";

  const actor = {
    userId: admin,
    bindings: [
      { role: "owner" as const, scope: "base" as const, scopeId: base.id },
    ],
  };
  const services = {
    db,
    bus: { publish: () => Promise.resolve() } as never,
    log: () => undefined,
  };
  const [rowId] = await createRows(
    services,
    await loadRowScope(db, actor, table),
    [{ values: { [note]: "first", [price]: "4.25" } }],
    { source: "web" },
  );
  const read = async () =>
    readPage(
      db,
      (await loadEngine(db, created.id, () => true)).engine,
      { limit: 10, timeZone: "UTC" },
      { total: true },
    );
  const first = await read();
  expect(first.total).toBe(1);
  expect(first.rows[0]?.id).toBe(rowId);
  expect(first.rows[0]?.[note]).toBe("first");
  // The decimals stay where they were written.
  expect(Number(first.rows[0]?.[price])).toBe(4.25);
  expect(Number(await scalar(`select ${quote(price)} from ${located}`))).toBe(
    4.25,
  );

  const due = await addColumn(db, admin, created.id, {
    label: "Due",
    fieldType: "date",
  });
  await updateRows(
    services,
    await loadRowScope(db, actor, table),
    [{ rowId: rowId ?? "", values: { [due.name]: "2026-03-04" } }],
    { source: "web" },
  );
  expect((await read()).rows[0]?.[due.name]).toBe("2026-03-04");
  // A field placed second moves the others along, as on any table.
  const code = await addColumn(
    db,
    admin,
    created.id,
    { label: "Code", fieldType: "text" },
    1,
  );
  const positions = await db
    .selectFrom("dataColumns")
    .select(["name", "position"])
    .where("tableId", "=", created.id)
    .orderBy("position")
    .execute();
  expect(new Set(positions.map((row) => row.position)).size).toBe(
    positions.length,
  );
  expect(positions[1]?.name).toBe(code.name);
  // A kind of field that is no column there is refused, plainly.
  await expect(
    addColumn(db, admin, created.id, { label: "Spent", fieldType: "duration" }),
  ).rejects.toMatchObject({ code: "source_home_field_type" });

  // Reading the table's columns again finds what the catalog says.
  expect(await refreshExposedTable(deps, admin, created.id)).toMatchObject({
    added: [],
    changed: [],
    removed: [],
  });

  // A field, then the table, deleted for good: dropped there too.
  const purge = {
    db,
    files: new DiskStore(await mkdtemp(join(tmpdir(), "ag-home-"))),
    log: () => undefined,
  };
  await trashColumn(db, admin, table, due.name);
  const trashed = await db
    .selectFrom("dataColumns")
    .select("id")
    .where("tableId", "=", created.id)
    .where("name", "=", due.name)
    .executeTakeFirstOrThrow();
  await purgeItem(purge, { kind: "column", id: trashed.id, actorId: admin });
  expect(
    await count(
      `select count(*) from information_schema.columns where table_schema = '${schema}' and column_name = '${due.name}'`,
    ),
  ).toBe(0);
  await trashTable(db, admin, table);
  await purgeItem(purge, { kind: "table", id: created.id, actorId: admin });
  expect(
    await count(
      `select count(*) from information_schema.tables where table_schema = '${schema}'`,
    ),
  ).toBe(0);

  // A second table stays until the schema goes, with it.
  await insertTable(db, admin, {
    baseId: base.id,
    name: "Kept",
    columns: [{ label: "Note", fieldType: "text" }],
  });
  await expect(dropHostedSchema(db, base.id, "public")).rejects.toMatchObject({
    code: "invalid_arguments",
  });
  await dropHostedSchema(db, base.id, schema);
  expect(
    await count(
      `select count(*) from information_schema.schemata where schema_name = '${schema}'`,
    ),
  ).toBe(0);
}
