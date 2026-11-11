/**
 * Exposing tables of a source in a base (ADR 0006): the administrator picks
 * them; nothing is exposed by default. Their rows stay in the client's
 * database. The catalog records each table, its columns under their own
 * names, and its foreign keys as links, both ways, between exposed tables.
 */
import {
  AppError,
  deriveColumnName,
  madeNames,
  OPTION_COLORS,
  PRIMARY_TYPES,
  type FieldType,
} from "@anygriddb/core";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { withAudit, type AuditTx } from "../data/audit-context.js";
import { isUniqueViolation } from "../data/schema-ops.js";
import { sourceTables, type SourceDeps } from "./sources.js";
import type { SourceTable } from "./types.js";

export type ExposeInput = {
  sourceId: string;
  baseId: string;
  tables: ReadonlyArray<{ schema: string; name: string }>;
};

const keyOf = (table: { schema: string; name: string }) =>
  `${table.schema}\u0000${table.name}`;

/** A free name in the base: `invoices`, else `invoices (2)`, … */
function freeName(wanted: string, taken: Set<string>): string {
  let name = wanted;
  for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1) {
    name = `${wanted} (${String(suffix)})`;
  }
  taken.add(name.toLowerCase());
  return name;
}

/**
 * How a client's number shows: an integer without decimals, a key without
 * thousands separators (invoice 1001, not 1 001), and a `numeric(14,2)`
 * with its two decimals.
 */
function numberConfig(type: string, isKey: boolean): Record<string, unknown> {
  // `numeric(14,2)`, `decimal(14,2) unsigned`; `integer`, `int(11)`,
  // `bigint unsigned`, `tinyint(4)` (MySQL and MariaDB spell them so).
  const scale =
    /^(?:numeric|decimal)\(\s*\d+\s*,\s*(\d+)\s*\)(?:\s+unsigned)?(?:\s+zerofill)?$/i.exec(
      type,
    );
  const integer =
    /^(?:tinyint|smallint|mediumint|int|integer|bigint)(?:\(\d+\))?(?:\s+unsigned)?(?:\s+zerofill)?$/i.test(
      type,
    );
  const precision = scale
    ? Math.min(Number(scale[1]), 8)
    : integer
      ? 0
      : undefined;
  const number = {
    ...(precision === undefined ? {} : { precision }),
    ...(isKey ? { thousands: false } : {}),
  };
  return Object.keys(number).length > 0 ? { number } : {};
}

/** Column names that usually name a row: a name, a label, a code. */
const NAMING =
  /^(name|nom|label|libelle|libellé|title|titre|designation|désignation|code|ref|reference|référence|sku|number|numero|numéro)$|_(name|nom|label|libelle|title|titre|code|ref)$/i;

/**
 * The column whose value names a row in links: a column of text named
 * like a name or a code (always filled first), or named after the table
 * (`city` in `cities`); else the key, an order number, rather than a note
 * left blank in most rows or a status shared by thousands; else any text;
 * else the first column a primary field may be.
 */
function primaryColumn(
  table: SourceTable,
  links: ReadonlyMap<string, string>,
): SourceTable["columns"][number] | undefined {
  const own = table.columns.filter(
    (column) => !links.has(column.name) && !column.field.readOnly,
  );
  const texts = own.filter(
    (column) =>
      !table.primaryKey.includes(column.name) &&
      (column.field.fieldType === "text" ||
        column.field.fieldType === "long_text"),
  );
  const short = texts.filter((column) => column.field.fieldType === "text");
  // `city` in `cities`, `country` in `countries`: the row's own name.
  const stem = table.name.toLowerCase().replace(/(ies|es|s)$/, "");
  const ownName = (name: string) => {
    const lower = name.toLowerCase();
    return stem.length >= 3 && (lower === stem || lower.startsWith(stem));
  };
  const [key, ...more] = table.primaryKey;
  return (
    short.find((column) => !column.nullable && NAMING.test(column.name)) ??
    texts.find((column) => NAMING.test(column.name)) ??
    short.find((column) => ownName(column.name)) ??
    (key !== undefined && more.length === 0
      ? own.find((column) => column.name === key)
      : undefined) ??
    texts.find((column) => !column.nullable) ??
    short[0] ??
    texts[0] ??
    own.find((column) => PRIMARY_TYPES.has(column.field.fieldType))
  );
}

/** AnyGridDB writes the column's type back exactly, and the account may update it. */
function writable(column: SourceTable["columns"][number]): boolean {
  return column.canUpdate && !column.field.readOnly;
}

type SourceColumn = SourceTable["columns"][number];

/** A select's options, keeping the colors of those it had. */
function optionsConfig(
  options: readonly string[],
  previous: ReadonlyArray<{ name: string; color?: string }> = [],
): Record<string, unknown> {
  return {
    options: options.map((name, at) => ({
      name: name.slice(0, 80),
      color:
        previous.find((option) => option.name === name.slice(0, 80))?.color ??
        OPTION_COLORS[at % OPTION_COLORS.length] ??
        "gray",
    })),
    preventNewOptions: true,
  };
}

/** How a client's column shows: a select's options, a number's format. */
function clientConfig(
  table: SourceTable,
  column: SourceColumn,
  fieldType: FieldType,
  previous?: ReadonlyArray<{ name: string; color?: string }>,
): Record<string, unknown> {
  const options = column.field.options;
  if (fieldType === "single_select" && options) {
    return optionsConfig(options, previous);
  }
  return fieldType === "number"
    ? numberConfig(column.type, table.primaryKey.includes(column.name))
    : {};
}

/**
 * A client's column as a field of the table `tableId`; a link when it is
 * a foreign key to an exposed table's key, with the list of the rows that
 * point to it on the other side.
 */
async function addClientColumn(
  tx: AuditTx,
  input: {
    tableId: string;
    table: SourceTable;
    column: SourceColumn;
    position: number;
    taken: Set<string>;
    /** The exposed table the column's foreign key points to. */
    target: string | undefined;
    isPrimary: boolean;
  },
): Promise<{ id: string; name: string }> {
  const { table, column, target } = input;
  const fieldType: FieldType = target
    ? "relation_one_to_many"
    : column.field.fieldType;
  const inserted = await tx
    .insertInto("dataColumns")
    .values({
      tableId: input.tableId,
      name: deriveColumnName(column.name, input.taken),
      label: column.name,
      description: column.comment,
      physicalName: column.name,
      externalType: column.type,
      externalWritable: writable(column),
      externalInsertable: !column.field.readOnly && column.canInsert,
      fieldType,
      config: clientConfig(table, column, fieldType),
      position: input.position,
      isPrimary: input.isPrimary && !target,
    })
    .returning(["id", "name"])
    .executeTakeFirstOrThrow();
  input.taken.add(inserted.name);
  if (!target) return inserted;
  await tx
    .insertInto("relations")
    .values({
      fromColumnId: inserted.id,
      toTableId: target,
      kind: "one_to_many",
    })
    .execute();
  // The other side lists the rows that point to it; it has no column of
  // its own in the client's table.
  const inverseTaken = new Set(
    (
      await tx
        .selectFrom("dataColumns")
        .select("name")
        .where("tableId", "=", target)
        .execute()
    ).map((item) => item.name),
  );
  const inverse = await tx
    .insertInto("dataColumns")
    .values({
      tableId: target,
      name: deriveColumnName(table.name, inverseTaken),
      label: table.name,
      physicalName: `x_${randomBytes(12).toString("hex")}`,
      externalType: null,
      fieldType: "relation_one_to_many",
      config: { inverseOf: inserted.id },
      position: 10_000 + input.position,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await tx
    .insertInto("relations")
    .values({
      fromColumnId: inverse.id,
      toTableId: input.tableId,
      kind: "one_to_many",
    })
    .execute();
  return inserted;
}

/** The exposed tables a table's foreign keys of one column point to, by column. */
function linksOf(
  table: SourceTable,
  exposed: ReadonlyMap<string, string>,
  found: ReadonlyMap<string, SourceTable>,
): Map<string, string> {
  const links = new Map<string, string>();
  for (const key of table.foreignKeys) {
    const target = exposed.get(keyOf(key.target));
    const [column, ...more] = key.columns;
    const targetTable = found.get(keyOf(key.target));
    if (
      target &&
      column !== undefined &&
      more.length === 0 &&
      targetTable?.primaryKey.length === 1 &&
      key.targetColumns[0] === targetTable.primaryKey[0]
    ) {
      links.set(column, target);
    }
  }
  return links;
}

export type TableWrites = { update: boolean; insert: boolean; delete: boolean };

/**
 * Enables or disables writes to an exposed table (ADR 0006): editing,
 * adding, and deleting rows apart. What the source's account may do is
 * read again now, never taken from an earlier look: a right it lacks is
 * refused, and each column takes writes only if the account may update it.
 */
export async function setTableWrites(
  deps: SourceDeps,
  actorId: string,
  input: { tableId: string } & TableWrites,
): Promise<{ baseId: string } & TableWrites> {
  const table = await deps.db
    .selectFrom("dataTables")
    .select([
      "id",
      "baseId",
      "sourceId",
      "externalSchema",
      "externalName",
      "externalKey",
    ])
    .where("id", "=", input.tableId)
    .where("storage", "=", "external")
    .where("deletedAt", "is", null)
    .executeTakeFirst();
  if (!table?.sourceId || !table.externalSchema || !table.externalName) {
    throw new AppError("unknown_table");
  }
  const found = (await sourceTables(deps, table.sourceId)).find(
    (item) =>
      item.schema === table.externalSchema && item.name === table.externalName,
  );
  if (!found) throw new AppError("source_schema_changed");
  const wanted = input.update || input.insert || input.delete;
  if (wanted && found.primaryKey.length === 0) {
    throw new AppError("external_table_no_key");
  }
  for (const [right, asked] of [
    ["UPDATE", input.update && !found.privileges.update],
    ["INSERT", input.insert && !found.privileges.insert],
    ["DELETE", input.delete && !found.privileges.delete],
  ] as const) {
    if (asked) throw new AppError("source_write_denied", right);
  }
  const columns = new Map(found.columns.map((column) => [column.name, column]));
  await withAudit(deps.db, { userId: actorId, source: "web" }, async (tx) => {
    await tx
      .updateTable("dataTables")
      .set({
        externalUpdate: input.update,
        externalInsert: input.insert,
        externalDelete: input.delete,
      })
      .where("id", "=", table.id)
      .execute();
    const stored = await tx
      .selectFrom("dataColumns")
      .select(["id", "physicalName", "externalWritable", "externalInsertable"])
      .where("tableId", "=", table.id)
      .where("externalType", "is not", null)
      // AnyGridDB's own fields are not the client's (ADR 0032).
      .where("externalSide", "=", false)
      .execute();
    for (const column of stored) {
      const source = columns.get(column.physicalName);
      const now = {
        externalWritable: source ? writable(source) : false,
        externalInsertable: source
          ? !source.field.readOnly && source.canInsert
          : false,
      };
      if (
        now.externalWritable === column.externalWritable &&
        now.externalInsertable === column.externalInsertable
      ) {
        continue;
      }
      await tx
        .updateTable("dataColumns")
        .set(now)
        .where("id", "=", column.id)
        .execute();
    }
  });
  return {
    baseId: table.baseId,
    update: input.update,
    insert: input.insert,
    delete: input.delete,
  };
}

export async function exposeTables(
  deps: SourceDeps,
  actorId: string,
  input: ExposeInput,
  /** Each table's first view, in the asker's language. */
  viewName: string = madeNames().grid,
): Promise<{ tableIds: string[] }> {
  if (input.tables.length === 0 || input.tables.length > 100) {
    throw new AppError("invalid_input");
  }
  // Every engine reads its rows where they live.
  const source = await deps.db
    .selectFrom("sources")
    .select("engine")
    .where("id", "=", input.sourceId)
    .executeTakeFirst();
  if (!source) throw new AppError("unknown_source");
  // What the account sees now, never what the request says it sees.
  const found = new Map(
    (await sourceTables(deps, input.sourceId)).map((table) => [
      keyOf(table),
      table,
    ]),
  );
  const chosen: SourceTable[] = input.tables.map((wanted) => {
    const table = found.get(keyOf(wanted));
    if (!table)
      throw new AppError("unknown_table", `${wanted.schema}.${wanted.name}`);
    return table;
  });
  try {
    return await withAudit(
      deps.db,
      { userId: actorId, source: "web" },
      async (tx) => {
        const base = await tx
          .selectFrom("bases")
          .select("id")
          .where("id", "=", input.baseId)
          .where("deletedAt", "is", null)
          .executeTakeFirst();
        if (!base) throw new AppError("unknown_base");
        const existing = await tx
          .selectFrom("dataTables")
          .select([
            "id",
            "name",
            "sourceId",
            "externalSchema",
            "externalName",
            "deletedAt",
          ])
          .where("baseId", "=", input.baseId)
          .execute();
        const names = new Set(
          existing.map((table) => table.name.toLowerCase()),
        );
        let position = existing.length;
        // Exposed tables of this source in the base, by client name: links
        // reach the ones exposed before too.
        const exposed = new Map<string, string>();
        for (const table of existing) {
          if (
            table.deletedAt === null &&
            table.sourceId === input.sourceId &&
            table.externalSchema &&
            table.externalName
          ) {
            exposed.set(
              keyOf({ schema: table.externalSchema, name: table.externalName }),
              table.id,
            );
          }
        }
        const created: Array<{ id: string; table: SourceTable }> = [];
        for (const table of chosen) {
          if (exposed.has(keyOf(table))) continue;
          const row = await tx
            .insertInto("dataTables")
            .values({
              baseId: input.baseId,
              name: freeName(table.name, names),
              description: table.comment,
              // Nothing of AnyGridDB is stored under this name: no DDL
              // ever reaches the client, and this one names no table.
              physicalName: `x_${randomBytes(16).toString("hex")}`,
              storage: "external",
              sourceId: input.sourceId,
              externalSchema: table.schema,
              externalName: table.name,
              externalKey: table.primaryKey,
              position: position++,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
          exposed.set(keyOf(table), row.id);
          created.push({ id: row.id, table });
        }

        for (const { id, table } of created) {
          // A foreign key of one column, to an exposed table's own key,
          // becomes the link field; other columns keep their mapped type.
          const links = linksOf(table, exposed, found);
          const taken = new Set<string>();
          const primary = primaryColumn(table, links);
          for (const [index, column] of table.columns.entries()) {
            await addClientColumn(tx, {
              tableId: id,
              table,
              column,
              position: index,
              taken,
              target: links.get(column.name),
              isPrimary: column === primary,
            });
          }
          await tx
            .insertInto("views")
            .values({
              tableId: id,
              name: viewName,
              viewType: "grid",
              config: {},
              position: 0,
            })
            .execute();
        }
        return { tableIds: created.map((item) => item.id) };
      },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("table_already_exists", { cause: error });
    }
    throw error;
  }
}

export type RefreshResult = {
  baseId: string;
  /** Client columns that became fields. */
  added: string[];
  /** Fields whose type, options, or rights followed the client's column. */
  changed: string[];
  /** Fields whose client column is gone, now in the trash. */
  removed: string[];
};

/**
 * Brings an exposed table back in line with the client's (ADR 0006): what
 * its DBA added, changed, or dropped since. A new column becomes a field,
 * a link when it is a foreign key to an exposed table; a field follows its
 * column's type, list of values, and rights, under the same name, so views
 * and formulas keep it; a field whose column is gone goes to the trash, as
 * it would break every read. The primary key follows too: without one,
 * writes stop.
 */
export async function refreshExposedTable(
  deps: SourceDeps,
  actorId: string,
  tableId: string,
): Promise<RefreshResult> {
  const table = await deps.db
    .selectFrom("dataTables")
    .select([
      "id",
      "baseId",
      "sourceId",
      "externalSchema",
      "externalName",
      "externalKey",
    ])
    .where("id", "=", tableId)
    .where("storage", "=", "external")
    .where("deletedAt", "is", null)
    .executeTakeFirst();
  if (!table?.sourceId || !table.externalSchema || !table.externalName) {
    throw new AppError("unknown_table");
  }
  const sourceId = table.sourceId;
  const found = new Map(
    (await sourceTables(deps, sourceId)).map((item) => [keyOf(item), item]),
  );
  const client = found.get(
    keyOf({ schema: table.externalSchema, name: table.externalName }),
  );
  if (!client) throw new AppError("source_schema_changed");
  const result: RefreshResult = {
    baseId: table.baseId,
    added: [],
    changed: [],
    removed: [],
  };
  await withAudit(
    deps.db,
    { userId: actorId, tableId: table.id, source: "web" },
    async (tx) => {
      const exposed = new Map<string, string>();
      for (const item of await tx
        .selectFrom("dataTables")
        .select(["id", "externalSchema", "externalName"])
        .where("baseId", "=", table.baseId)
        .where("sourceId", "=", sourceId)
        .where("deletedAt", "is", null)
        .execute()) {
        if (item.externalSchema && item.externalName) {
          exposed.set(
            keyOf({ schema: item.externalSchema, name: item.externalName }),
            item.id,
          );
        }
      }
      const links = linksOf(client, exposed, found);
      const stored = await tx
        .selectFrom("dataColumns")
        .select([
          "id",
          "name",
          "label",
          "physicalName",
          "fieldType",
          "config",
          "externalType",
          "externalWritable",
          "externalInsertable",
          "position",
          "deletedAt",
          "externalSide",
        ])
        .where("tableId", "=", table.id)
        .execute();
      // The client's columns only: AnyGridDB's own fields live in the side
      // table (ADR 0032), not in the client's.
      const byPhysical = new Map(
        stored
          .filter(
            (column) => column.externalType !== null && !column.externalSide,
          )
          .map((column) => [column.physicalName, column]),
      );
      const taken = new Set(stored.map((column) => column.name));
      // Lists of linking rows sit at 10,000 and past; fields before them.
      let position = Math.max(
        -1,
        ...stored
          .filter((column) => column.position < 10_000)
          .map((column) => column.position),
      );
      const now = new Date();
      for (const column of client.columns) {
        const field = byPhysical.get(column.name);
        if (!field) {
          position += 1;
          await addClientColumn(tx, {
            tableId: table.id,
            table: client,
            column,
            position,
            taken,
            target: links.get(column.name),
            isPrimary: false,
          });
          result.added.push(column.name);
          continue;
        }
        // A field an administrator put in the trash stays there.
        if (field.deletedAt !== null) continue;
        const isLink = field.fieldType === "relation_one_to_many";
        const fieldType: FieldType = isLink
          ? field.fieldType
          : column.field.fieldType;
        const previous = (field.config as { options?: unknown } | null)
          ?.options;
        const config = isLink
          ? field.config
          : clientConfig(
              client,
              column,
              fieldType,
              Array.isArray(previous)
                ? (previous as Array<{ name: string; color?: string }>)
                : undefined,
            );
        const next = {
          fieldType,
          config,
          externalType: column.type,
          externalWritable: writable(column),
          externalInsertable: !column.field.readOnly && column.canInsert,
        };
        const same =
          next.fieldType === field.fieldType &&
          next.externalType === field.externalType &&
          next.externalWritable === field.externalWritable &&
          next.externalInsertable === field.externalInsertable &&
          JSON.stringify(next.config ?? {}) ===
            JSON.stringify(field.config ?? {});
        if (same) continue;
        await tx
          .updateTable("dataColumns")
          .set(next)
          .where("id", "=", field.id)
          .execute();
        result.changed.push(field.label);
      }
      // A client column that is gone: its field would break every read.
      const present = new Set(client.columns.map((column) => column.name));
      for (const field of byPhysical.values()) {
        if (field.deletedAt !== null || present.has(field.physicalName)) {
          continue;
        }
        await tx
          .updateTable("dataColumns")
          .set({ deletedAt: now, deletedBy: actorId, isPrimary: false })
          .where("id", "=", field.id)
          .execute();
        // A link's list on the other side goes with it.
        await tx
          .updateTable("dataColumns")
          .set({ deletedAt: now, deletedBy: actorId })
          .where("deletedAt", "is", null)
          .where(sql<boolean>`config->>'inverseOf' = ${field.id}`)
          .execute();
        result.removed.push(field.label);
      }
      // Soft-deleting the primary left no live label: pick one again.
      const liveClient = (
        await tx
          .selectFrom("dataColumns")
          .select([
            "id",
            "physicalName",
            "isPrimary",
            "externalType",
            "externalSide",
          ])
          .where("tableId", "=", table.id)
          .where("deletedAt", "is", null)
          .execute()
      ).filter(
        (column) => column.externalType !== null && !column.externalSide,
      );
      if (!liveClient.some((column) => column.isPrimary)) {
        const elected = primaryColumn(client, links);
        const match = elected
          ? liveClient.find((column) => column.physicalName === elected.name)
          : undefined;
        if (match) {
          await tx
            .updateTable("dataColumns")
            .set({ isPrimary: false })
            .where("tableId", "=", table.id)
            .where("deletedAt", "is", null)
            .execute();
          await tx
            .updateTable("dataColumns")
            .set({ isPrimary: true })
            .where("id", "=", match.id)
            .execute();
        }
      }
      const key = client.primaryKey;
      if (JSON.stringify(key) !== JSON.stringify(table.externalKey ?? [])) {
        await tx
          .updateTable("dataTables")
          .set({
            externalKey: key,
            ...(key.length === 0
              ? {
                  externalUpdate: false,
                  externalInsert: false,
                  externalDelete: false,
                }
              : {}),
          })
          .where("id", "=", table.id)
          .execute();
      }
    },
  );
  return result;
}
