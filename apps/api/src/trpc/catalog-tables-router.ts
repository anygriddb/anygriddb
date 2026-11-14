/**
 * Tables, and the folders they are kept in.
 */
import {
  AppError,
  createTableInputSchema,
  deleteTableInputSchema,
  duplicateTableInputSchema,
  reorderTablesInputSchema,
  updateTableInputSchema,
} from "@anygriddb/core";
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
import { trashTable } from "../data/trash.js";
import { publishCatalog } from "../realtime/channels.js";
import { guardBase, guardTable, handle } from "./guard.js";
import { procedure, requestNames } from "./init.js";
import { queueDeps } from "./jobs-router.js";
import { logPublish } from "./catalog-shared.js";

export const catalogTableProcedures = {
  createTable: procedure
    .input(createTableInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "manage");
        const created = await insertTable(ctx.db, user.id, {
          ...input,
          viewName: (await requestNames(ctx)).grid,
        });
        await publishCatalog(ctx.bus, input.baseId, logPublish(ctx));
        return created;
      }),
    ),
  /** Copies a table in the background; the job's result names the copy. */
  duplicateTable: procedure
    .input(duplicateTableInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "manage");
        await guardBase(ctx, table.baseId, "manage");
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
  updateTable: procedure
    .input(updateTableInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "manage");
        await updateTable(ctx.db, user.id, input);
        await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  reorderTables: procedure
    .input(reorderTablesInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "manage");
        await reorderTables(ctx.db, user.id, input.baseId, input.order);
        await publishCatalog(ctx.bus, input.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  createFolder: procedure
    .input(createFolderInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "manage");
        const folder = await createFolder(ctx.db, user.id, input);
        await publishCatalog(ctx.bus, input.baseId, logPublish(ctx));
        return folder;
      }),
    ),
  updateFolder: procedure
    .input(updateFolderInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const folder = await ctx.db
          .selectFrom("tableFolders")
          .select(["id", "baseId", "deletedAt"])
          .where("id", "=", input.folderId)
          .executeTakeFirst();
        if (!folder || folder.deletedAt) throw new AppError("unknown_folder");
        const { user } = await guardBase(ctx, folder.baseId, "manage");
        const updated = await updateFolder(ctx.db, user.id, input);
        await publishCatalog(ctx.bus, folder.baseId, logPublish(ctx));
        return updated;
      }),
    ),
  deleteFolder: procedure
    .input(deleteFolderInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const folder = await ctx.db
          .selectFrom("tableFolders")
          .select(["id", "baseId", "deletedAt"])
          .where("id", "=", input.folderId)
          .executeTakeFirst();
        if (!folder || folder.deletedAt) throw new AppError("unknown_folder");
        const { user } = await guardBase(ctx, folder.baseId, "manage");
        await deleteFolder(ctx.db, user.id, input.folderId);
        await publishCatalog(ctx.bus, folder.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  moveTableToFolder: procedure
    .input(moveTableToFolderInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "manage");
        await guardBase(ctx, table.baseId, "manage");
        await moveTableToFolder(ctx.db, user.id, input);
        await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  reorderFolders: procedure
    .input(reorderFoldersInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "manage");
        await reorderFolders(ctx.db, user.id, input.baseId, input.order);
        await publishCatalog(ctx.bus, input.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  reorderFolderTables: procedure
    .input(reorderFolderTablesInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const folder = await ctx.db
          .selectFrom("tableFolders")
          .select(["id", "baseId", "deletedAt"])
          .where("id", "=", input.folderId)
          .executeTakeFirst();
        if (!folder || folder.deletedAt) throw new AppError("unknown_folder");
        const { user } = await guardBase(ctx, folder.baseId, "manage");
        await reorderFolderTables(ctx.db, user.id, input.folderId, input.order);
        await publishCatalog(ctx.bus, folder.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  deleteTable: procedure
    .input(deleteTableInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "manage");
        await trashTable(ctx.db, user.id, table);
        await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
};
