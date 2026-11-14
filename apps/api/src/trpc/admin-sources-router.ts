/**
 * Client databases, as an administrator declares them.
 */
import { sourceInputSchema, sourceUpdateSchema } from "@anygriddb/core";
import { z } from "zod";
import {
  exposeTables,
  refreshExposedTable,
  setTableWrites,
} from "../sources/expose.js";
import { setTableWatch, watchColumns } from "../sources/watch.js";
import { setTableSync, syncNow } from "../sources/sync.js";
import {
  createSource,
  deleteSource,
  exposedIn,
  listSources,
  recheckSource,
  sourceTables,
  testSource,
  updateSource,
  type SourceDeps,
} from "../sources/sources.js";
import { publishCatalog } from "../realtime/channels.js";
import type { Context } from "./context.js";
import { handle } from "./guard.js";
import { requestNames, t } from "./init.js";
import { procedure, requireAdmin } from "./admin-procedure.js";

function sourceDeps(ctx: Context): SourceDeps {
  return {
    db: ctx.db,
    key: ctx.env.AUTH_ENCRYPTION_KEY,
    settings: ctx.sources,
  };
}

/** Client databases (ADR 0026): declared and checked by administrators. */
export const sourcesRouter = t.router({
  settings: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return {
        allowedHosts: [...ctx.sources.allowedHosts],
        allowPlaintext: ctx.sources.allowPlaintext,
      };
    }),
  ),
  list: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return listSources(ctx.db);
    }),
  ),
  test: procedure.input(sourceInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return testSource(sourceDeps(ctx), input);
    }),
  ),
  create: procedure.input(sourceInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      const created = await createSource(sourceDeps(ctx), admin.id, input);
      ctx.req.log.info(
        { actor: admin.id, source: created.id },
        "source declared",
      );
      return created;
    }),
  ),
  update: procedure.input(sourceUpdateSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      return updateSource(sourceDeps(ctx), admin.id, input);
    }),
  ),
  check: procedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        return recheckSource(sourceDeps(ctx), input.id);
      }),
    ),
  expose: procedure
    .input(
      z.object({
        sourceId: z.uuid(),
        baseId: z.uuid(),
        tables: z
          .array(
            z.object({
              schema: z.string().min(1).max(128),
              name: z.string().min(1).max(128),
            }),
          )
          .min(1)
          .max(100),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const result = await exposeTables(
          sourceDeps(ctx),
          admin.id,
          input,
          (await requestNames(ctx)).grid,
        );
        await publishCatalog(ctx.bus, input.baseId, (error) => {
          ctx.req.log.error({ err: error }, "catalog publish failed");
        });
        return result;
      }),
    ),
  setWrites: procedure
    .input(
      z.object({
        tableId: z.uuid(),
        update: z.boolean(),
        insert: z.boolean(),
        delete: z.boolean(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const result = await setTableWrites(sourceDeps(ctx), admin.id, input);
        await publishCatalog(ctx.bus, result.baseId, (error) => {
          ctx.req.log.error({ err: error }, "catalog publish failed");
        });
        return result;
      }),
    ),
  refreshTable: procedure
    .input(z.object({ tableId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const result = await refreshExposedTable(
          sourceDeps(ctx),
          admin.id,
          input.tableId,
        );
        await publishCatalog(ctx.bus, result.baseId, (error) => {
          ctx.req.log.error({ err: error }, "catalog publish failed");
        });
        return result;
      }),
    ),
  setWatch: procedure
    .input(
      z.object({
        tableId: z.uuid(),
        method: z.enum(["column", "change_tracking"]).nullable(),
        column: z.string().min(1).max(128).optional(),
        intervalSeconds: z.int().min(5).max(86_400),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await setTableWatch(sourceDeps(ctx), admin.id, input);
        return { ok: true as const };
      }),
    ),
  setSync: procedure
    .input(
      z.object({
        tableId: z.uuid(),
        // Null reads the table live again.
        intervalMinutes: z.int().min(1).max(10_080).nullable(),
        syncMode: z.enum(["full", "incremental"]).optional(),
        changeColumn: z.string().min(1).max(128).nullable().optional(),
        fullEvery: z.int().min(1).max(10_080).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const { baseId } = await setTableSync(ctx.db, admin.id, input);
        await publishCatalog(ctx.bus, baseId, (error) => {
          ctx.req.log.error({ err: error }, "catalog publish failed");
        });
        return { ok: true as const };
      }),
    ),
  /**
   * Where each exposed table stands (writes, watch, copy), from AnyGridDB's
   * database only: cheap to read again while a refresh runs.
   */
  exposures: procedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        return Object.fromEntries(await exposedIn(ctx.db, input.id));
      }),
    ),
  syncNow: procedure
    .input(z.object({ tableId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        await syncNow(ctx.db, input.tableId);
        return { ok: true as const };
      }),
    ),
  tables: procedure.input(z.object({ id: z.uuid() })).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const [tables, exposed, source] = await Promise.all([
        sourceTables(sourceDeps(ctx), input.id),
        exposedIn(ctx.db, input.id),
        ctx.db
          .selectFrom("sources")
          .select("engine")
          .where("id", "=", input.id)
          .executeTakeFirstOrThrow(),
      ]);
      return tables.map((table) => ({
        ...table,
        changeTracking: table.changeTracking ?? false,
        // Columns that can tell changes made elsewhere (ADR 0031).
        watchColumns: watchColumns(source.engine, table),
        exposedIn: exposed.get(`${table.schema}.${table.name}`) ?? [],
      }));
    }),
  ),
  delete: procedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await deleteSource(sourceDeps(ctx), admin.id, input.id);
        return { ok: true as const };
      }),
    ),
});
