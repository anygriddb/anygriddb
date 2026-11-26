/**
 * Tables, and the folders they are kept in.
 */
import {
  AppError,
  createTableInputSchema,
  deleteTableInputSchema,
  duplicateTableInputSchema,
  assertCircuitDefinition,
  getTableCircuitInputSchema,
  isWritableType,
  listCircuitTemplatesInputSchema,
  saveCircuitInputSchema,
  reorderTablesInputSchema,
  updateTableInputSchema,
} from "@anygriddb/core";
import {
  circuitCounts,
  listCircuitTemplates,
  saveTableCircuit,
  loadTableCircuit,
} from "../data/status-circuits.js";
import { enqueueJob } from "../jobs.js";
import {
  createFolder,
  createFolderInputSchema,
  deleteFolder,
  deleteFolderInputSchema,
  moveTableToFolder,
  moveTableToFolderInputSchema,
  reorderFolderTables,
  reorderFolderTablesInputSchema,
  reorderFolders,
  reorderFoldersInputSchema,
  updateFolder,
  updateFolderInputSchema,
} from "../data/folders.js";
import { insertTable, reorderTables, updateTable } from "../data/schema-ops.js";
import { assertMayCopyRows } from "../data/data-ops.js";
import { trashTable } from "../data/trash.js";
import { publishCatalog } from "../realtime/channels.js";
import {
  authorize,
  baseAccess,
  guardBase,
  guardTable,
  handle,
} from "./guard.js";
import { asking, requestNames } from "./init.js";
import { queueDeps } from "./jobs-router.js";
import { logPublish } from "./catalog-shared.js";

export const catalogTableProcedures = {
  createTable: asking({ asks: ["schema.manage"] })
    .input(createTableInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "schema.manage");
        const created = await insertTable(ctx.db, user.id, {
          ...input,
          viewName: (await requestNames(ctx)).grid,
        });
        await publishCatalog(ctx.bus, input.baseId, logPublish(ctx));
        return created;
      }),
    ),
  /** Copies a table in the background; the job's result names the copy. */
  duplicateTable: asking({ asks: ["schema.manage"], also: ["data.export"] })
    .input(duplicateTableInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, bindings, table } = await guardTable(
          ctx,
          input.tableId,
          "schema.manage",
        );
        await guardBase(ctx, table.baseId, "schema.manage");
        if (input.withData) {
          await assertMayCopyRows(ctx.db, { userId: user.id, bindings }, table);
        }
        const job = await enqueueJob(queueDeps(ctx), {
          kind: "duplicate_table",
          userId: user.id,
          baseId: table.baseId,
          tableId: table.id,
          input: {
            tableId: table.id,
            name:
              input.name ??
              (await requestNames(ctx)).copy(table.name).slice(0, 100),
            withData: input.withData,
          },
        });
        return { jobId: job.id };
      }),
    ),
  updateTable: asking({ asks: ["schema.manage"] })
    .input(updateTableInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(
          ctx,
          input.tableId,
          "schema.manage",
        );
        await updateTable(ctx.db, user.id, input);
        await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  reorderTables: asking({ asks: ["schema.manage"] })
    .input(reorderTablesInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "schema.manage");
        await reorderTables(ctx.db, user.id, input.baseId, input.order);
        await publishCatalog(ctx.bus, input.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  createFolder: asking({ asks: ["schema.manage"] })
    .input(createFolderInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "schema.manage");
        const folder = await createFolder(ctx.db, user.id, input);
        await publishCatalog(ctx.bus, input.baseId, logPublish(ctx));
        return folder;
      }),
    ),
  updateFolder: asking({ asks: ["schema.manage"] })
    .input(updateFolderInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const folder = await ctx.db
          .selectFrom("tableFolders")
          .select(["id", "baseId", "deletedAt"])
          .where("id", "=", input.folderId)
          .executeTakeFirst();
        if (!folder || folder.deletedAt) throw new AppError("unknown_folder");
        const { user } = await baseAccess(
          ctx,
          actor,
          folder.baseId,
          "schema.manage",
        );
        const updated = await updateFolder(ctx.db, user.id, input);
        await publishCatalog(ctx.bus, folder.baseId, logPublish(ctx));
        return updated;
      }),
    ),
  deleteFolder: asking({ asks: ["schema.manage"] })
    .input(deleteFolderInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const folder = await ctx.db
          .selectFrom("tableFolders")
          .select(["id", "baseId", "deletedAt"])
          .where("id", "=", input.folderId)
          .executeTakeFirst();
        if (!folder || folder.deletedAt) throw new AppError("unknown_folder");
        const { user } = await baseAccess(
          ctx,
          actor,
          folder.baseId,
          "schema.manage",
        );
        await deleteFolder(ctx.db, user.id, input.folderId);
        await publishCatalog(ctx.bus, folder.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  moveTableToFolder: asking({ asks: ["schema.manage"] })
    .input(moveTableToFolderInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(
          ctx,
          input.tableId,
          "schema.manage",
        );
        await guardBase(ctx, table.baseId, "schema.manage");
        await moveTableToFolder(ctx.db, user.id, input);
        await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  reorderFolders: asking({ asks: ["schema.manage"] })
    .input(reorderFoldersInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "schema.manage");
        await reorderFolders(ctx.db, user.id, input.baseId, input.order);
        await publishCatalog(ctx.bus, input.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  reorderFolderTables: asking({ asks: ["schema.manage"] })
    .input(reorderFolderTablesInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const folder = await ctx.db
          .selectFrom("tableFolders")
          .select(["id", "baseId", "deletedAt"])
          .where("id", "=", input.folderId)
          .executeTakeFirst();
        if (!folder || folder.deletedAt) throw new AppError("unknown_folder");
        const { user } = await baseAccess(
          ctx,
          actor,
          folder.baseId,
          "schema.manage",
        );
        await reorderFolderTables(ctx.db, user.id, input.folderId, input.order);
        await publishCatalog(ctx.bus, folder.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  deleteTable: asking({ asks: ["schema.manage"] })
    .input(deleteTableInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(
          ctx,
          input.tableId,
          "schema.manage",
        );
        await trashTable(ctx.db, user.id, table);
        await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  /** The table's status circuit (ADR 0124). */
  getCircuit: asking({ asks: ["rows.read"] })
    .input(getTableCircuitInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(ctx, input.tableId, "rows.read");
        return loadTableCircuit(ctx.db, input.tableId);
      }),
    ),
  listCircuitTemplates: asking({ exception: "ownBases" })
    .input(listCircuitTemplatesInputSchema)
    .query(({ ctx }) =>
      handle(ctx, async () => {
        await authorize(ctx);
        return listCircuitTemplates(ctx.db);
      }),
    ),
  /** Rows of each state, for the editor to ask where those of a removed one go. */
  circuitCounts: asking({ asks: ["schema.manage"] })
    .input(getTableCircuitInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const { table } = await guardTable(ctx, input.tableId, "schema.manage");
        return circuitCounts(ctx.db, {
          tableId: table.id,
          physicalName: table.physicalName,
        });
      }),
    ),
  /**
   * Saves a table's circuit as its editor drew it, a template's included:
   * the fields it names are the table's own stored ones, the made roles
   * its steps name exist.
   */
  saveCircuit: asking({ asks: ["schema.manage"] })
    .input(saveCircuitInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { table, user } = await guardTable(
          ctx,
          input.tableId,
          "schema.manage",
        );
        assertCircuitDefinition(input.circuit);
        const named = [
          ...input.circuit.states.flatMap(
            (state) => state.writableFields ?? [],
          ),
          ...input.circuit.steps.flatMap((step) => step.fields),
        ];
        if (named.length > 0) {
          const stored = new Set(
            (
              await ctx.db
                .selectFrom("dataColumns")
                .select(["name", "fieldType"])
                .where("tableId", "=", table.id)
                .where("deletedAt", "is", null)
                .execute()
            )
              .filter((column) => isWritableType(column.fieldType))
              .map((column) => column.name),
          );
          if (named.some((name) => !stored.has(name))) {
            throw new AppError("invalid_column");
          }
        }
        const made = [
          ...new Set(input.circuit.steps.flatMap((step) => step.madeRoles)),
        ];
        if (made.length > 0) {
          const found = await ctx.db
            .selectFrom("madeRoles")
            .select("id")
            .where("id", "in", made)
            .execute();
          if (found.length !== made.length) throw new AppError("unknown_role");
        }
        const circuit = await saveTableCircuit(ctx.db, {
          userId: user.id,
          tableId: table.id,
          circuit: input.circuit,
          remap: input.remap,
          physicalName: table.physicalName,
          storage: table.storage === "external" ? "external" : "native",
        });
        await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
        return circuit;
      }),
    ),
};
