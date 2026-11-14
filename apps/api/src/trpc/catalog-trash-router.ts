/**
 * The trash of bases, tables, fields, and views.
 */
import {
  AppError,
  effectiveTableRole,
  purgeTrashInputSchema,
  restoreInputSchema,
  roleAllows,
  roleFor,
  trashListInputSchema,
} from "@anygriddb/core";
import { enqueueJob } from "../jobs.js";
import {
  baseTrashItems,
  itemBaseId,
  listTrash,
  listTrashedBases,
  loadTrashedTable,
  loadTrashedView,
  restoreBase,
  restoreColumn,
  restoreTable,
  restoreView,
  trashedColumnTable,
} from "../data/trash.js";
import { canEditView } from "../data/views.js";
import { publishCatalog } from "../realtime/channels.js";
import { authorize, guardBase, guardTable, handle } from "./guard.js";
import { procedure } from "./init.js";
import { queueDeps } from "./jobs-router.js";
import { logPublish } from "./catalog-shared.js";

export const catalogTrashProcedures = {
  /** What a base's trash holds that the caller may restore. */
  trash: procedure.input(trashListInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user, bindings, role } = await guardBase(
        ctx,
        input.baseId,
        "read",
      );
      const manageBase = roleAllows(role, "manage");
      const items = await listTrash(ctx.db, input.baseId, user.id);
      const tableRole = (tableId: string | null) =>
        tableId ? effectiveTableRole(bindings, tableId, input.baseId) : null;
      return {
        items: items.filter((item) => {
          if (item.kind === "table") return manageBase;
          if (item.kind === "column") {
            return roleAllows(tableRole(item.tableId), "manage");
          }
          return roleAllows(tableRole(item.tableId), "write");
        }),
        canPurge: manageBase,
      };
    }),
  ),
  /** Bases in the trash that the caller managed. */
  trashedBases: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      const { bindings } = await authorize(ctx);
      const managed = bindings
        .filter(
          (binding) =>
            binding.scope === "base" && roleAllows(binding.role, "manage"),
        )
        .map((binding) => binding.scopeId);
      return { items: await listTrashedBases(ctx.db, managed) };
    }),
  ),
  restore: procedure.input(restoreInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      switch (input.kind) {
        case "base": {
          const { bindings } = await authorize(ctx);
          if (!roleAllows(roleFor(bindings, "base", input.id), "manage")) {
            throw new AppError("access_denied");
          }
          await restoreBase(ctx.db, input.id);
          await publishCatalog(ctx.bus, input.id, logPublish(ctx));
          return { baseId: input.id, tableId: null };
        }
        case "table": {
          const table = await loadTrashedTable(ctx.db, input.id);
          const { user } = await guardBase(ctx, table.baseId, "manage");
          await restoreTable(ctx.db, user.id, table.id);
          await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
          return { baseId: table.baseId, tableId: table.id };
        }
        case "column": {
          const owner = await trashedColumnTable(ctx.db, input.id);
          const { user } = await guardTable(ctx, owner.tableId, "manage");
          await restoreColumn(ctx.db, user.id, input.id);
          await publishCatalog(ctx.bus, owner.baseId, logPublish(ctx));
          return { baseId: owner.baseId, tableId: owner.tableId };
        }
        case "view": {
          const view = await loadTrashedView(ctx.db, input.id);
          const { user, role, table } = await guardTable(
            ctx,
            view.tableId,
            "read",
          );
          if (!canEditView(view, user.id, role)) {
            throw new AppError("access_denied");
          }
          await restoreView(ctx.db, view);
          return { baseId: table.baseId, tableId: table.id };
        }
      }
    }),
  ),
  /** Deletes items of a base's trash for good, in a background job. */
  purgeTrash: procedure
    .input(purgeTrashInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, bindings } = await authorize(ctx);
        if (!roleAllows(roleFor(bindings, "base", input.baseId), "manage")) {
          throw new AppError("access_denied");
        }
        const items =
          input.items ?? (await baseTrashItems(ctx.db, input.baseId, user.id));
        if (items.length === 0) return { jobId: null };
        for (const item of items) {
          if ((await itemBaseId(ctx.db, item)) !== input.baseId) {
            throw new AppError("invalid_restore");
          }
        }
        const job = await enqueueJob(queueDeps(ctx), {
          kind: "trash_purge",
          userId: user.id,
          baseId: input.baseId,
          input: { baseId: input.baseId, items },
        });
        return { jobId: job.id };
      }),
    ),
};
