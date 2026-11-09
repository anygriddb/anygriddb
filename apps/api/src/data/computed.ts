import {
  AppError,
  deriveColumnName,
  describeColumns,
  isRelationType,
  rollupFitsTarget,
  type RollupFn,
  type FilterGroup,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql as sqlTag } from "kysely";
import { withAudit } from "./audit-context.js";
import { assembleEngine, loadCatalogRows } from "./engine.js";
import { liveColumn } from "./live.js";
import { isUniqueViolation } from "./schema-ops.js";

/**
 * Adds a lookup (`fn` absent) or a rollup over a link column. The target
 * may be any column of the linked table except another link.
 */
export async function insertComputed(
  db: Database,
  userId: string,
  input: {
    tableId: string;
    name?: string;
    label?: string;
    relation: string;
    target: string;
    fn?: RollupFn;
    filter?: FilterGroup;
  },
  canRead: (tableId: string) => boolean,
): Promise<{ id: string; name: string }> {
  const all = await db
    .selectFrom("dataColumns")
    .selectAll()
    .where("tableId", "=", input.tableId)
    .execute();
  // Fields in the trash keep their names, but nothing new may build on them.
  const own = all.filter((column) => !column.deletedAt);
  const relation = own.find((column) => column.name === input.relation);
  if (!relation || !isRelationType(relation.fieldType)) {
    throw new AppError("invalid_relation");
  }
  const link = await db
    .selectFrom("relations")
    .selectAll()
    .where("fromColumnId", "=", relation.id)
    .executeTakeFirst();
  if (!link) {
    throw new AppError("invalid_relation");
  }
  if (!canRead(link.toTableId)) {
    throw new AppError("access_denied");
  }
  const targetColumns = await db
    .selectFrom("dataColumns")
    .selectAll()
    .where("tableId", "=", link.toTableId)
    .where(liveColumn())
    .execute();
  const target = targetColumns.find((column) => column.name === input.target);
  if (!target) {
    throw new AppError("unknown_column", input.target);
  }
  if (isRelationType(target.fieldType)) {
    throw new AppError("invalid_relation");
  }
  const fn = input.fn;
  if (fn && !rollupFitsTarget(fn, target.fieldType)) {
    throw new AppError("invalid_formula");
  }
  const label =
    input.label ?? input.name ?? `${relation.label} · ${target.label}`;
  if (
    own.some((column) => column.label.toLowerCase() === label.toLowerCase())
  ) {
    throw new AppError("column_already_exists");
  }
  const name =
    input.name ??
    deriveColumnName(label, new Set(all.map((column) => column.name)));
  const config = {
    relation: input.relation,
    target: input.target,
    ...(fn ? { fn } : {}),
    ...(input.filter?.conditions.length ? { filter: input.filter } : {}),
  };
  const rows = await loadCatalogRows(db, [input.tableId]);
  const trial = assembleEngine(
    input.tableId,
    {
      ...rows,
      columns: [
        ...rows.columns,
        {
          ...relation,
          id: "planned",
          name,
          physicalName: name,
          label,
          fieldType: fn ? "rollup" : "lookup",
          config,
          isPrimary: false,
          isUnique: false,
          requireReason: false,
        },
      ],
    },
    () => true,
  );
  const described = describeColumns(trial).find(
    (column) => column.name === name,
  );
  // The compile error as the AppError it was: an unknown field in the
  // condition, an operator its kind refuses.
  if (described?.cause) {
    throw new AppError(described.cause.code, described.cause.detail);
  }
  if (!described || described.error) {
    throw new Error(described?.error ?? "Invalid formula");
  }
  try {
    return await withAudit(
      db,
      { userId, tableId: input.tableId, source: "web" },
      async (tx) => {
        const position = await tx
          .selectFrom("dataColumns")
          .select(sqlTag<number>`coalesce(max(position) + 1, 0)::int`.as("max"))
          .where("tableId", "=", input.tableId)
          .executeTakeFirst();
        const inserted = await tx
          .insertInto("dataColumns")
          .values({
            tableId: input.tableId,
            name,
            physicalName: name,
            fieldType: fn ? "rollup" : "lookup",
            requireReason: false,
            config,
            label,
            position: position?.max ?? 0,
          })
          .returning("id")
          .executeTakeFirst();
        if (!inserted) {
          throw new AppError("no_row");
        }
        return { id: inserted.id, name };
      },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("column_already_exists", { cause: error });
    }
    throw error;
  }
}
