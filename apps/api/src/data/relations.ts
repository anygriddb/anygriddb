import { randomBytes } from "node:crypto";
import {
  AppError,
  buildAddForeignKeyColumn,
  buildClearLinks,
  buildCreateJunction,
  buildExistingIds,
  buildForeignKeyIndex,
  buildInsertLinks,
  buildReadCells,
  buildReadHolders,
  buildReadJunction,
  buildReadReferencing,
  buildReadRows,
  buildReadStatus,
  buildRemoveLinks,
  buildSetLink,
  cellText,
  deriveColumnName,
  type EngineCatalog,
  type EngineColumn,
  isReservedColumnName,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql as sqlTag } from "kysely";
import { runRows, withAudit, type AuditTx } from "./audit-context.js";
import { liveTable } from "./live.js";
import {
  assertWritable,
  changeJunctionSide,
  changeKeySide,
  leaveParents,
  linkMapOf,
  type LinkWriter,
} from "./row-links.js";
import { assertOwnRowsStayInRule, readTransaction } from "./rows.js";
import { isForeignKeyViolation } from "./pg-error.js";
import { isUniqueViolation } from "./schema-ops.js";
import { selectionFilter } from "./link-selection.js";

function junctionName(): string {
  return `j_${randomBytes(16).toString("hex")}`;
}

async function nextPosition(tx: AuditTx, tableId: string): Promise<number> {
  const row = await tx
    .selectFrom("dataColumns")
    .select(sqlTag<number>`coalesce(max(position) + 1, 0)::int`.as("max"))
    .where("tableId", "=", tableId)
    .executeTakeFirst();
  return row?.max ?? 0;
}

/** Every name a table's fields hold, and the labels of those outside the trash. */
async function columnNamesOf(db: Database, tableId: string) {
  const rows = await db
    .selectFrom("dataColumns")
    .select(["name", "label", "deletedAt"])
    .where("tableId", "=", tableId)
    .execute();
  return {
    names: new Set(rows.map((row) => row.name)),
    live: rows.filter((row) => !row.deletedAt),
  };
}

function uniqueLabel(
  existing: readonly { label: string }[],
  label: string,
): string {
  const taken = new Set(existing.map((column) => column.label.toLowerCase()));
  if (!taken.has(label.toLowerCase())) {
    return label;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${label} ${index}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  throw new AppError("column_already_exists");
}

/**
 * Adds a link column. One-to-many stores a foreign key on the source table;
 * many-to-many creates a junction. `twoWay` also adds the inverse column
 * on the target table, sharing the same storage.
 */
export async function addRelation(
  db: Database,
  userId: string,
  input: {
    tableId: string;
    name?: string;
    label?: string;
    kind: "one_to_many" | "many_to_many";
    targetTableId: string;
    twoWay?: boolean;
    inverseLabel?: string;
    /** Kept when free, as a snapshot restore asks; derived otherwise. */
    inverseName?: string;
  },
): Promise<{ id: string; name: string; inverseId: string | null }> {
  const source = await db
    .selectFrom("dataTables")
    .selectAll()
    .where("id", "=", input.tableId)
    .where(liveTable())
    .executeTakeFirst();
  if (source?.storage === "external") {
    throw new AppError("external_table_schema");
  }
  const target = await db
    .selectFrom("dataTables")
    .selectAll()
    .where("id", "=", input.targetTableId)
    .where(liveTable())
    .executeTakeFirst();
  if (!source || !target) {
    throw new AppError("no_row");
  }
  // Links between a client's tables come from its foreign keys; none is
  // added to or from one.
  if (target.storage === "external") {
    throw new AppError("external_table_schema");
  }
  if (source.baseId !== target.baseId) {
    throw new AppError("invalid_relation");
  }
  const sourceColumns = await columnNamesOf(db, source.id);
  const label = uniqueLabel(
    sourceColumns.live,
    input.label ?? input.name ?? target.name,
  );
  const name = input.name ?? deriveColumnName(label, sourceColumns.names);
  if (sourceColumns.names.has(name)) {
    throw new AppError("column_already_exists");
  }
  const twoWay = input.twoWay === true && source.id !== target.id;
  const targetColumns = twoWay
    ? await columnNamesOf(db, target.id)
    : { names: new Set<string>(), live: [] };
  const inverseLabel = twoWay
    ? uniqueLabel(targetColumns.live, input.inverseLabel ?? source.name)
    : "";
  const inverseName = !twoWay
    ? ""
    : input.inverseName &&
        !targetColumns.names.has(input.inverseName) &&
        !isReservedColumnName(input.inverseName)
      ? input.inverseName
      : deriveColumnName(inverseLabel, targetColumns.names);
  const junction = input.kind === "many_to_many" ? junctionName() : null;
  const fieldType =
    input.kind === "one_to_many"
      ? "relation_one_to_many"
      : "relation_many_to_many";
  try {
    return await withAudit(
      db,
      { userId, tableId: source.id, source: "web" },
      async (tx) => {
        const created = await tx
          .insertInto("dataColumns")
          .values({
            tableId: source.id,
            name,
            physicalName: name,
            fieldType,
            config: {},
            label,
            position: await nextPosition(tx, source.id),
          })
          .returning("id")
          .executeTakeFirst();
        if (!created) {
          throw new AppError("no_row");
        }
        let inverseId: string | null = null;
        if (twoWay) {
          const inverse = await tx
            .insertInto("dataColumns")
            .values({
              tableId: target.id,
              name: inverseName,
              physicalName: inverseName,
              fieldType: "relation_many_to_many",
              config: { inverseOf: created.id },
              label: inverseLabel,
              position: await nextPosition(tx, target.id),
            })
            .returning("id")
            .executeTakeFirst();
          inverseId = inverse?.id ?? null;
        }
        await tx
          .insertInto("relations")
          .values({
            fromColumnId: created.id,
            toTableId: target.id,
            kind: input.kind,
            junctionName: junction,
            inverseColumnId: inverseId,
          })
          .execute();
        if (inverseId) {
          await tx
            .insertInto("relations")
            .values({
              fromColumnId: inverseId,
              toTableId: source.id,
              kind: input.kind,
              junctionName: null,
              inverseColumnId: created.id,
            })
            .execute();
        }
        if (input.kind === "one_to_many") {
          await runRows(
            tx,
            buildAddForeignKeyColumn({
              table: source.physicalName,
              column: name,
              targetTable: target.physicalName,
            }),
          );
          await runRows(
            tx,
            buildForeignKeyIndex({ table: source.physicalName, column: name }),
          );
        } else {
          for (const statement of buildCreateJunction({
            junction: junction ?? "",
            leftTable: source.physicalName,
            rightTable: target.physicalName,
          })) {
            await runRows(tx, statement);
          }
        }
        return { id: created.id, name, inverseId };
      },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("column_already_exists", { cause: error });
    }
    throw error;
  }
}

async function assertDraft(
  tx: AuditTx,
  physicalName: string,
  rowId: string,
): Promise<void> {
  const rows = await runRows(
    tx,
    buildReadStatus({ table: physicalName, id: rowId }),
  );
  const status = rows[0]?.ag_status;
  if (typeof status !== "string") {
    throw new AppError("no_row");
  }
  if (status === "locked" || status === "signed") {
    throw new AppError("row_locked");
  }
}

/** The list a row's links become once `change` is applied to them. */
function changedList(current: readonly string[], change: LinkDelta): string[] {
  const removed = new Set(change.remove);
  return [
    ...new Set([...current.filter((id) => !removed.has(id)), ...change.add]),
  ];
}

type LinkDelta = { add: readonly string[]; remove: readonly string[] };

/**
 * Replaces the links of one row, or changes them by what `change` adds and
 * removes, read against the row's links in the same transaction. Forward
 * one-to-many updates the foreign key; inverse one-to-many updates the
 * foreign keys of the other rows, so their audit trail and locks apply;
 * many-to-many rewrites the junction and audits the change by hand, since
 * a junction has no row trigger. A row on the other side that shows a link
 * added or removed is asked too: refused when locked or signed, and the
 * change is written in its history, as a delete does (`row-links.ts`).
 */
export async function setLinks(
  db: Database,
  engine: EngineCatalog,
  input: {
    userId: string;
    tableId: string;
    physicalName: string;
    column: EngineColumn;
    rowId: string;
    /** The whole list, or `change`. */
    targetIds?: readonly string[];
    change?: LinkDelta;
    reason: string | null;
    /** Audit source: web by default, api for REST calls. */
    source?: string;
    /** How many automations led to this write. */
    depth?: number;
    /** A new row's links: its rule is asked once they are all written. */
    deferRule?: boolean;
  },
): Promise<{ touchedTables: string[] }> {
  const relation = input.column.relation;
  if (!relation) {
    throw new AppError("invalid_relation");
  }
  const target = engine.tables.get(relation.targetTableId);
  if (!target) {
    throw new AppError("invalid_relation");
  }
  const change = input.change;
  const listed = input.targetIds ?? [];
  const map = await linkMapOf(db, input.tableId);
  const who: LinkWriter = {
    userId: input.userId,
    tableId: input.tableId,
    physicalName: input.physicalName,
    reason: input.reason,
    source: input.source ?? "web",
  };
  if (
    relation.kind === "one_to_many" &&
    relation.direction === "forward" &&
    listed.length > 1
  ) {
    throw new AppError("invalid_link_count");
  }
  try {
    await withAudit(
      db,
      {
        userId: input.userId,
        tableId: input.tableId,
        reason: input.reason,
        source: input.source ?? "web",
        events: { depth: input.depth ?? 0 },
      },
      async (tx) => {
        const write = async (): Promise<void> => {
          // What a change removes need not be there any more.
          const named = change ? change.add : listed;
          if (named.length > 0) {
            const found = await runRows(
              tx,
              buildExistingIds({ table: target.physicalName, ids: named }),
            );
            if (found.length !== named.length) {
              throw new AppError("unknown_row");
            }
          }
          await assertDraft(tx, input.physicalName, input.rowId);
          if (relation.kind === "one_to_many") {
            if (!relation.fkColumn) {
              throw new AppError("invalid_relation");
            }
            if (relation.direction === "forward") {
              const key = map.ownKeys.find(
                (item) => item.column === relation.fkColumn,
              );
              let held: string | null = null;
              if (change || key?.inverseField) {
                const [cells] = await runRows(
                  tx,
                  buildReadCells({
                    table: input.physicalName,
                    id: input.rowId,
                    columns: [relation.fkColumn],
                  }),
                );
                const stored = cells?.[relation.fkColumn];
                held = typeof stored === "string" ? stored : null;
              }
              const single = change
                ? changedList(held === null ? [] : [held], change)
                : listed;
              if (single.length > 1) {
                throw new AppError("invalid_link_count");
              }
              if (key) {
                await changeKeySide(
                  tx,
                  who,
                  key,
                  input.rowId,
                  held,
                  single[0] ?? null,
                );
              }
              const updated = await runRows(
                tx,
                buildSetLink({
                  table: input.physicalName,
                  column: relation.fkColumn,
                  rowId: input.rowId,
                  targetId: single[0] ?? null,
                }),
              );
              if (updated.length !== 1) {
                throw new AppError("no_row");
              }
              return;
            }
            await sqlTag`select set_config('anygrid.table_id', ${target.id}, true)`.execute(
              tx,
            );
            const current = await runRows(
              tx,
              buildReadReferencing({
                table: target.physicalName,
                column: relation.fkColumn,
                targetId: input.rowId,
              }),
            );
            const targetIds = change
              ? changedList(
                  current.map((row) => String(row.id)),
                  change,
                )
              : listed;
            const wanted = new Set(targetIds);
            for (const row of current) {
              const id = String(row.id);
              if (!wanted.has(id)) {
                await runRows(
                  tx,
                  buildSetLink({
                    table: target.physicalName,
                    column: relation.fkColumn,
                    rowId: id,
                    targetId: null,
                  }),
                );
              }
            }
            const have = new Set(current.map((row) => String(row.id)));
            const joining = targetIds.filter((id) => !have.has(id));
            if (joining.length > 0) {
              // A row that moves here leaves the row it pointed to.
              const moving = await runRows(
                tx,
                buildReadHolders({
                  table: target.physicalName,
                  column: relation.fkColumn,
                  ids: joining,
                }),
              );
              const leaving = new Map<string, string[]>();
              for (const row of moving) {
                assertWritable(row.ag_status);
                if (typeof row.key === "string" && row.key !== input.rowId) {
                  leaving.set(row.key, [
                    ...(leaving.get(row.key) ?? []),
                    String(row.id),
                  ]);
                }
              }
              await leaveParents(
                tx,
                who,
                {
                  physical: input.physicalName,
                  tableId: input.tableId,
                  field: input.column.name,
                },
                { physical: target.physicalName, column: relation.fkColumn },
                leaving,
              );
            }
            for (const id of targetIds) {
              if (!have.has(id)) {
                await runRows(
                  tx,
                  buildSetLink({
                    table: target.physicalName,
                    column: relation.fkColumn,
                    rowId: id,
                    targetId: input.rowId,
                  }),
                );
              }
            }
            await sqlTag`select set_config('anygrid.table_id', ${input.tableId}, true)`.execute(
              tx,
            );
            // The other rows' keys are audited by their trigger; the row the
            // person edited records the change of its own field as well.
            await tx
              .insertInto("auditEvents")
              .values({
                userId: input.userId,
                action: "update",
                tableId: input.tableId,
                recordId: input.rowId,
                oldValue: { [input.column.name]: [...have] },
                newValue: { [input.column.name]: [...targetIds] },
                reason: input.reason,
                source: input.source ?? "web",
              })
              .execute();
            return;
          }
          if (!relation.junction) {
            throw new AppError("invalid_relation");
          }
          const near =
            relation.direction === "forward" ? "left_id" : "right_id";
          const far = relation.direction === "forward" ? "right_id" : "left_id";
          const previous = await runRows(
            tx,
            buildReadJunction({
              junction: relation.junction,
              side: near,
              id: input.rowId,
            }),
          );
          const oldIds = previous.flatMap((row) =>
            typeof row[far] === "string" ? [row[far]] : [],
          );
          const targetIds = change ? changedList(oldIds, change) : listed;
          const junction = map.junctions.find(
            (item) => item.junction === relation.junction && item.side === near,
          );
          if (junction) {
            const kept = new Set(targetIds);
            const had = new Set(oldIds);
            await changeJunctionSide(
              tx,
              who,
              junction,
              input.rowId,
              targetIds.filter((id) => !had.has(id)),
              oldIds.filter((id) => !kept.has(id)),
            );
          }
          // A change touches only what it names, whatever the list's length.
          const removed = change
            ? oldIds.filter((id) => change.remove.includes(id))
            : [];
          if (!change) {
            await runRows(
              tx,
              buildClearLinks({
                junction: relation.junction,
                side: near,
                id: input.rowId,
              }),
            );
          } else if (removed.length > 0) {
            await runRows(
              tx,
              buildRemoveLinks({
                junction: relation.junction,
                side: near,
                id: input.rowId,
                ids: removed,
              }),
            );
          }
          const inserted = change ? change.add : targetIds;
          if (inserted.length > 0) {
            const own = inserted.map(() => input.rowId);
            await runRows(
              tx,
              buildInsertLinks({
                junction: relation.junction,
                leftIds: relation.direction === "forward" ? own : inserted,
                rightIds: relation.direction === "forward" ? inserted : own,
              }),
            );
          }
          await tx
            .insertInto("auditEvents")
            .values({
              userId: input.userId,
              action: "update",
              tableId: input.tableId,
              recordId: input.rowId,
              oldValue: { [input.column.name]: oldIds },
              newValue: { [input.column.name]: targetIds },
              reason: input.reason,
              source: input.source ?? "web",
            })
            .execute();
        };
        await write();
        if (!input.deferRule) {
          await assertOwnRowsStayInRule(tx, engine, [input.rowId]);
        }
      },
    );
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      throw new AppError("unknown_row", { cause: error });
    }
    throw error;
  }
  return {
    touchedTables:
      relation.direction === "inverse" && relation.kind === "one_to_many"
        ? [target.id]
        : [],
  };
}

/** Rows of the linked table to pick from, searched by any text field. */
export async function linkCandidates(
  db: Database,
  engine: EngineCatalog,
  column: EngineColumn,
  search: string | undefined,
  limit: number,
): Promise<Array<{ id: string; label: string }>> {
  const relation = column.relation;
  if (!relation || !engine.readable(relation.targetTableId)) {
    return [];
  }
  const target = engine.tables.get(relation.targetTableId);
  if (!target) {
    return [];
  }
  const targetEngine: EngineCatalog = { ...engine, table: target };
  const primary = target.primaryColumn;
  // Only the rows the field's selection keeps (a view, a filter).
  const { filter } = await selectionFilter(db, column);
  const statement = buildReadRows(targetEngine, {
    limit,
    search,
    fields: primary ? [primary] : [],
    ...(filter ? { filter } : {}),
  });
  // In the client's database for a client's table, where the rows live.
  const rows = await readTransaction(db, targetEngine, (run) => run(statement));
  return rows.map((row) => {
    const value = primary ? row[primary] : null;
    const text = cellText(value);
    return { id: String(row.id), label: text === "" ? String(row.id) : text };
  });
}
