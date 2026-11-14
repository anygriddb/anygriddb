/**
 * Fields: adding, changing, converting, ordering, and linking them.
 */
import {
  addColumnInputSchema,
  addLookupInputSchema,
  addRelationInputSchema,
  addRollupInputSchema,
  AppError,
  columnFromAddInput,
  deleteColumnInputSchema,
  duplicateColumnInputSchema,
  previewConversionInputSchema,
  reorderColumnsInputSchema,
  setPrimaryColumnInputSchema,
  updateColumnInputSchema,
} from "@anygriddb/core";
import { z } from "zod";
import { insertComputed } from "../data/computed.js";
import { duplicateColumn } from "../data/data-ops.js";
import { addRelation } from "../data/relations.js";
import {
  addColumn,
  previewConversion,
  reorderColumns,
  setPrimaryColumn,
  updateColumn,
} from "../data/schema-ops.js";
import { trashColumn } from "../data/trash.js";
import { publishCatalog } from "../realtime/channels.js";
import type { Context } from "./context.js";
import { guardTable, handle, readableTables } from "./guard.js";
import { procedure, requestNames } from "./init.js";
import { logPublish } from "./catalog-shared.js";

/** The base of each table in one base: what a link inside it may reach. */
async function tablesOfBase(
  ctx: Context,
  baseId: string,
): Promise<Map<string, string>> {
  const rows = await ctx.db
    .selectFrom("dataTables")
    .select(["id", "baseId"])
    .where("baseId", "=", baseId)
    .execute();
  return new Map(rows.map((row) => [row.id, row.baseId]));
}

const reorderOptionsSchema = z.object({
  optionRenames: z
    .array(
      z.object({
        from: z.string().min(1).max(80),
        to: z.string().min(1).max(80),
      }),
    )
    .max(200)
    .optional(),
});

export const catalogFieldProcedures = {
  addColumn: procedure.input(addColumnInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user, table } = await guardTable(ctx, input.tableId, "manage");
      const created = await addColumn(
        ctx.db,
        user.id,
        table.id,
        columnFromAddInput(input),
        input.position,
      );
      await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
      return created;
    }),
  ),
  updateColumn: procedure
    .input(updateColumnInputSchema.extend(reorderOptionsSchema.shape))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "manage");
        await updateColumn(ctx.db, user.id, table, input);
        await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  duplicateColumn: procedure
    .input(duplicateColumnInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "manage");
        const created = await duplicateColumn(
          ctx.db,
          user.id,
          table,
          input.name,
          await requestNames(ctx),
        );
        await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
        return created;
      }),
    ),
  previewConversion: procedure
    .input(previewConversionInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const { table } = await guardTable(ctx, input.tableId, "manage");
        return previewConversion(ctx.db, table, input.name, input.fieldType);
      }),
    ),
  deleteColumn: procedure
    .input(deleteColumnInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "manage");
        await trashColumn(ctx.db, user.id, table, input.name);
        await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  reorderColumns: procedure
    .input(reorderColumnsInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "manage");
        await reorderColumns(ctx.db, user.id, table.id, input.order);
        await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  setPrimaryColumn: procedure
    .input(setPrimaryColumnInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "manage");
        await setPrimaryColumn(ctx.db, user.id, table.id, input.name);
        await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  addRelation: procedure
    .input(addRelationInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "manage");
        const target = await guardTable(
          ctx,
          input.targetTableId,
          input.twoWay ? "manage" : "read",
        );
        if (target.table.baseId !== table.baseId) {
          throw new AppError("invalid_relation");
        }
        const created = await addRelation(ctx.db, user.id, input);
        await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
        return created;
      }),
    ),
  addLookup: procedure.input(addLookupInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user, bindings, table } = await guardTable(
        ctx,
        input.tableId,
        "manage",
      );
      const baseOf = await tablesOfBase(ctx, table.baseId);
      const created = await insertComputed(
        ctx.db,
        user.id,
        input,
        readableTables(bindings, baseOf),
      );
      await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
      return created;
    }),
  ),
  addRollup: procedure.input(addRollupInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user, bindings, table } = await guardTable(
        ctx,
        input.tableId,
        "manage",
      );
      const baseOf = await tablesOfBase(ctx, table.baseId);
      const created = await insertComputed(
        ctx.db,
        user.id,
        input,
        readableTables(bindings, baseOf),
      );
      await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
      return created;
    }),
  ),
};
