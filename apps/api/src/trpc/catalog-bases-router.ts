/**
 * Bases: what a person sees of theirs, and making, copying, importing,
 * and exporting one.
 */
import {
  airtableBaseId,
  startAirtableImportInputSchema,
  AppError,
  BASE_TEMPLATES,
  type Binding,
  createBaseInputSchema,
  deleteBaseInputSchema,
  duplicateBaseInputSchema,
  effectiveTableRole,
  exportSnapshotJobInputSchema,
  findTemplate,
  importSnapshotJobInputSchema,
  importWorkbookInputSchema,
  listRestorePointsInputSchema,
  restoreBaseJobInputSchema,
  restorePointIdInputSchema,
  restorePointJobInputSchema,
  roleAllows,
  roleFor,
  tableActivityInputSchema,
  updateBaseInputSchema,
} from "@anygriddb/core";
import { z } from "zod";
import { readerAccess } from "../data/acl.js";
import { applyTemplate } from "../data/data-ops.js";
import { enqueueJob } from "../jobs.js";
import {
  assembleEngine,
  loadCatalogRows,
  sourceEngine,
  type CatalogRows,
} from "../data/engine.js";
import { countVisibleRows, listCollaborators } from "../data/rows.js";
import { liveBase, liveTable } from "../data/live.js";
import { listFolders } from "../data/folders.js";
import { insertBase, updateBase } from "../data/schema-ops.js";
import {
  deleteRestorePoint,
  findRestorePoint,
  listRestorePoints,
} from "../data/restore-points.js";
import { removeBase } from "../data/tables.js";
import {
  keepStagedWorkbook,
  loadStagedWorkbook,
  workbookBaseName,
} from "../data/workbook-import.js";
import { readSettings } from "../settings.js";
import { trashBase } from "../data/trash.js";
import { publishCatalog } from "../realtime/channels.js";
import type { Context } from "./context.js";
import { authorize, guardBase, handle, readableTables } from "./guard.js";
import { procedure, requestNames } from "./init.js";
import { queueDeps } from "./jobs-router.js";
import { encryptSecret } from "../auth/crypto.js";
import { publicColumns, logPublish } from "./catalog-shared.js";

function baseIndex(rows: CatalogRows): Map<string, string> {
  return new Map(rows.tables.map((table) => [table.id, table.baseId]));
}

async function visibleCatalog(ctx: Context, bindings: readonly Binding[]) {
  const scoped = new Set(bindings.map((binding) => binding.scopeId));
  const baseIds = new Set(
    bindings
      .filter((binding) => binding.scope === "base")
      .map((binding) => binding.scopeId),
  );
  // Only the tables the caller has a role on, directly or through a base.
  const tableRows =
    scoped.size === 0
      ? []
      : await ctx.db
          .selectFrom("dataTables")
          .selectAll()
          .where((eb) =>
            eb.or([
              eb("id", "in", [...scoped]),
              eb("baseId", "in", [...scoped]),
            ]),
          )
          .where(liveTable())
          .execute();
  for (const table of tableRows) {
    if (scoped.has(table.id)) {
      baseIds.add(table.baseId);
    }
  }
  const baseRows =
    baseIds.size === 0
      ? []
      : await ctx.db
          .selectFrom("bases")
          .selectAll()
          .where("id", "in", [...baseIds])
          .where(liveBase())
          .execute();
  const readableIds = tableRows
    .filter(
      (table) =>
        baseIds.has(table.baseId) &&
        roleAllows(
          effectiveTableRole(bindings, table.id, table.baseId),
          "read",
        ),
    )
    .map((table) => table.id);
  const rows = await loadCatalogRows(ctx.db, readableIds);
  return { baseRows, rows, readableIds };
}

const collaboratorsInputSchema = z.object({ baseId: z.uuid() });

export const catalogBaseProcedures = {
  list: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      const { user, bindings } = await authorize(ctx);
      const { baseRows, rows, readableIds } = await visibleCatalog(
        ctx,
        bindings,
      );
      const readable = readableTables(bindings, baseIndex(rows));
      const access = await readerAccess(
        ctx.db,
        { userId: user.id, bindings },
        rows.tables,
      );
      // Client tables read from a copy (ADR 0034), and when it was made.
      const externalIds = rows.tables
        .filter((table) => table.storage === "external")
        .map((table) => table.id);
      const syncs = new Map(
        (externalIds.length === 0
          ? []
          : await ctx.db
              .selectFrom("externalSyncs")
              .select(["tableId", "intervalMinutes", "syncedAt"])
              .where("tableId", "in", externalIds)
              .execute()
        ).map((sync) => [sync.tableId, sync]),
      );
      const folders = await listFolders(
        ctx.db,
        baseRows.map((base) => base.id),
      );
      // A folder's name is shown to whoever arranges the base, and to
      // others only when it holds a table they read.
      const holding = new Set(
        rows.tables
          .filter((table) => readableIds.includes(table.id))
          .map((table) => table.folderId),
      );
      return baseRows
        .sort(
          (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
        )
        .map((base) => ({
          id: base.id,
          name: base.name,
          description: base.description,
          role: roleFor(bindings, "base", base.id),
          folders: folders
            .filter(
              (folder) =>
                folder.baseId === base.id &&
                (holding.has(folder.id) ||
                  roleAllows(roleFor(bindings, "base", base.id), "manage")),
            )
            .map((folder) => ({
              id: folder.id,
              name: folder.name,
              position: folder.position,
            })),
          tables: rows.tables
            .filter(
              (table) =>
                table.baseId === base.id && readableIds.includes(table.id),
            )
            .sort(
              (left, right) =>
                left.position - right.position ||
                left.name.localeCompare(right.name),
            )
            .map((table) => {
              const engine = {
                ...assembleEngine(table.id, rows, readable),
                ...(access ? { access } : {}),
              };
              return {
                id: table.id,
                name: table.name,
                description: table.description,
                position: table.position,
                folderId: table.folderId,
                role: effectiveTableRole(bindings, table.id, table.baseId),
                // A client's table (ADR 0006): read where it lives.
                external:
                  table.storage === "external" &&
                  table.externalSchema !== null &&
                  table.externalName !== null
                    ? {
                        schema: table.externalSchema,
                        name: table.externalName,
                        engine: sourceEngine(rows, table.sourceId),
                        // Which database it lives in, by the name an
                        // administrator gave it: never its address or account.
                        source:
                          table.sourceId === null
                            ? null
                            : {
                                id: table.sourceId,
                                name:
                                  rows.sources.get(table.sourceId)?.name ?? "",
                              },
                        // What an administrator enabled (ADR 0006); a
                        // copy takes no writes (ADR 0034).
                        writes: {
                          update: table.externalUpdate && !syncs.has(table.id),
                          insert: table.externalInsert && !syncs.has(table.id),
                          delete: table.externalDelete && !syncs.has(table.id),
                        },
                        // Storage fields: live table with a key (side schema
                        // or control plane, ADR 0032 / 0046).
                        enrichable:
                          !syncs.has(table.id) &&
                          (table.externalKey ?? []).length > 0 &&
                          table.sourceId !== null,
                        enrichment: syncs.has(table.id)
                          ? ("off" as const)
                          : (table.externalKey ?? []).length === 0 ||
                              table.sourceId === null
                            ? ("off" as const)
                            : rows.sources.get(table.sourceId)?.sideSchema
                              ? ("client" as const)
                              : ("control_plane" as const),
                        enrichmentBlocked: syncs.has(table.id)
                          ? ("synced" as const)
                          : (table.externalKey ?? []).length === 0
                            ? ("no_key" as const)
                            : null,
                        // Read from a copy, refreshed on a schedule.
                        synced: syncs.has(table.id)
                          ? {
                              at:
                                syncs.get(table.id)?.syncedAt?.toISOString() ??
                                null,
                              intervalMinutes:
                                syncs.get(table.id)?.intervalMinutes ?? 15,
                            }
                          : null,
                      }
                    : null,
                columns: publicColumns(engine, rows),
              };
            }),
        }));
    }),
  ),
  /**
   * What the home page says of the tables a person opened: how many rows
   * they see, and when each last changed and by whom. Only the tables they
   * can read, and only AnyGridDB's own: a client's rows live in its
   * database. A table whose rows are filtered for them has no last change:
   * it could tell of rows they cannot see.
   */
  activity: procedure.input(tableActivityInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user, bindings } = await authorize(ctx);
      const { rows, readableIds } = await visibleCatalog(ctx, bindings);
      const wanted = new Set(input.tableIds);
      const tables = rows.tables.filter(
        (table) =>
          wanted.has(table.id) &&
          readableIds.includes(table.id) &&
          table.storage !== "external",
      );
      if (tables.length === 0) return [];
      const readable = readableTables(bindings, baseIndex(rows));
      const access = await readerAccess(
        ctx.db,
        { userId: user.id, bindings },
        rows.tables,
      );
      const engines = tables.map((table) => ({
        ...assembleEngine(table.id, rows, readable),
        ...(access ? { access } : {}),
      }));
      const counts: Array<{ total: number; estimated: boolean }> = [];
      for (const engine of engines) {
        counts.push(await countVisibleRows(ctx.db, engine));
      }
      const open = engines
        .filter((engine) => !engine.access?.rowFilter(engine.table.id))
        .map((engine) => engine.table.id);
      const changes =
        open.length === 0
          ? []
          : await ctx.db
              .selectFrom("auditEvents")
              .innerJoin("users", "users.id", "auditEvents.userId")
              .distinctOn("auditEvents.tableId")
              .select([
                "auditEvents.tableId",
                "auditEvents.occurredAt",
                "auditEvents.userId",
                "users.displayName",
              ])
              .where("auditEvents.tableId", "in", open)
              // Taking rows out changes nothing (ROADMAP #31).
              .where("auditEvents.action", "<>", "export")
              .orderBy("auditEvents.tableId")
              .orderBy("auditEvents.occurredAt", "desc")
              .execute();
      const last = new Map(changes.map((change) => [change.tableId, change]));
      return tables.map((table, index) => {
        const change = last.get(table.id);
        return {
          tableId: table.id,
          rows: counts[index] ?? null,
          changed: change
            ? {
                at: change.occurredAt.toISOString(),
                by: { id: change.userId, name: change.displayName },
              }
            : null,
        };
      });
    }),
  ),
  collaborators: procedure
    .input(collaboratorsInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const { bindings } = await authorize(ctx);
        const tableRows = await ctx.db
          .selectFrom("dataTables")
          .select(["id", "baseId"])
          .where("baseId", "=", input.baseId)
          .execute();
        const allowed =
          roleFor(bindings, "base", input.baseId) !== null ||
          tableRows.some(
            (table) =>
              table.baseId === input.baseId &&
              roleAllows(
                effectiveTableRole(bindings, table.id, table.baseId),
                "read",
              ),
          );
        if (!allowed) {
          throw new AppError("access_denied");
        }
        return { users: await listCollaborators(ctx.db, input.baseId) };
      }),
    ),
  templates: procedure.query(() =>
    BASE_TEMPLATES.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      tables: template.tables.map((table) => table.name),
    })),
  ),
  createBase: procedure
    .input(createBaseInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await authorize(ctx, true);
        const template = input.template ? findTemplate(input.template) : null;
        if (input.template && !template) {
          throw new AppError("unknown_template");
        }
        const created = await insertBase(ctx.db, user.id, input);
        if (!template) {
          return created;
        }
        try {
          await applyTemplate(
            ctx.db,
            user.id,
            created.id,
            template,
            await requestNames(ctx),
          );
        } catch (error) {
          // A half-built base is worse than none: remove it, then report.
          await removeBase(
            ctx.db,
            ctx.files,
            user.id,
            created.id,
            (cleanup) => {
              ctx.req.log.error({ err: cleanup }, "template cleanup failed");
            },
          );
          throw error;
        }
        return created;
      }),
    ),
  updateBase: procedure
    .input(updateBaseInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "manage");
        await updateBase(ctx.db, user.id, input);
        return { ok: true as const };
      }),
    ),
  deleteBase: procedure
    .input(deleteBaseInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "manage");
        await trashBase(ctx.db, user.id, input.baseId);
        await publishCatalog(ctx.bus, input.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
  /** Builds a portable JSON of the base in the background. */
  exportSnapshot: procedure
    .input(exportSnapshotJobInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "manage");
        const job = await enqueueJob(queueDeps(ctx), {
          kind: "export_snapshot",
          userId: user.id,
          baseId: input.baseId,
          input,
        });
        return { jobId: job.id };
      }),
    ),
  /**
   * Imports an Airtable base as a new base, in the background. The token
   * goes into the job sealed with the instance's key, and leaves it when
   * the job ends.
   */
  importAirtable: procedure
    .input(startAirtableImportInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await authorize(ctx, true);
        const airtableBase = airtableBaseId(input.base);
        if (!airtableBase) throw new AppError("airtable_base_not_found");
        const sealed = encryptSecret(
          input.token,
          ctx.env.AUTH_ENCRYPTION_KEY,
          "job-token",
        );
        const job = await enqueueJob(queueDeps(ctx), {
          kind: "import_airtable",
          userId: user.id,
          input: {
            airtableBaseId: airtableBase,
            ...(input.name ? { name: input.name } : {}),
            token: {
              ciphertext: sealed.ciphertext.toString("base64"),
              nonce: sealed.nonce.toString("base64"),
            },
          },
        });
        return { jobId: job.id };
      }),
    ),
  /** Creates a new base from a staged snapshot upload. */
  importSnapshot: procedure
    .input(importSnapshotJobInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await authorize(ctx, true);
        const job = await enqueueJob(queueDeps(ctx), {
          kind: "import_snapshot",
          userId: user.id,
          input,
        });
        return { jobId: job.id };
      }),
    ),
  /**
   * Makes a base of a staged workbook's chosen sheets, in the background
   * (ADR 0078): the job's result names the base. Making a base needs a
   * second factor.
   */
  importWorkbook: procedure
    .input(importWorkbookInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await authorize(ctx, true);
        const staged = await loadStagedWorkbook(
          ctx.db,
          input.importId,
          user.id,
        );
        const found = new Set(staged.sheets.map((sheet) => sheet.sheet));
        if (input.sheets.some((sheet) => !found.has(sheet))) {
          throw new AppError("invalid_mapping");
        }
        await keepStagedWorkbook(ctx.db, input.importId);
        const job = await enqueueJob(queueDeps(ctx), {
          kind: "import_workbook",
          userId: user.id,
          input: {
            importId: input.importId,
            name: input.name ?? workbookBaseName(staged.filename),
            sheets: input.sheets,
          },
        });
        return { jobId: job.id };
      }),
    ),
  /**
   * Copies a base in the background, through its snapshot: the job's
   * result names the copy. Making a base needs a second factor.
   */
  duplicateBase: procedure
    .input(duplicateBaseInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "manage");
        await authorize(ctx, true);
        const base = await ctx.db
          .selectFrom("bases")
          .select("name")
          .where("id", "=", input.baseId)
          .executeTakeFirstOrThrow();
        const job = await enqueueJob(queueDeps(ctx), {
          kind: "duplicate_base",
          userId: user.id,
          baseId: input.baseId,
          input: {
            baseId: input.baseId,
            name:
              input.name ??
              (await requestNames(ctx)).copy(base.name).slice(0, 100),
            withData: input.withData,
          },
        });
        return { jobId: job.id };
      }),
    ),
  /**
   * A base's restore points (ADR 0077), newest first, and how long the
   * instance keeps each one.
   */
  restorePoints: procedure
    .input(listRestorePointsInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardBase(ctx, input.baseId, "manage");
        return {
          points: await listRestorePoints(ctx.db, input.baseId),
          keepDays: (await readSettings(ctx.db)).restorePointDays,
        };
      }),
    ),
  /** Makes a restore point of the base, in the background. */
  makeRestorePoint: procedure
    .input(restorePointJobInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "manage");
        const job = await enqueueJob(queueDeps(ctx), {
          kind: "restore_point",
          userId: user.id,
          baseId: input.baseId,
          input,
        });
        return { jobId: job.id };
      }),
    ),
  /**
   * Reads a restore point back into a new base, in the background: the
   * job's result names it. Making a base needs a second factor.
   */
  restoreBase: procedure
    .input(restoreBaseJobInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const point = await findRestorePoint(ctx.db, input.restorePointId);
        const { user } = await guardBase(ctx, point.baseId, "manage");
        await authorize(ctx, true);
        const base = await ctx.db
          .selectFrom("bases")
          .select("name")
          .where("id", "=", point.baseId)
          .executeTakeFirstOrThrow();
        const job = await enqueueJob(queueDeps(ctx), {
          kind: "restore_base",
          userId: user.id,
          baseId: point.baseId,
          input: {
            restorePointId: point.id,
            name:
              input.name ??
              (await requestNames(ctx)).restored(base.name).slice(0, 100),
          },
        });
        return { jobId: job.id };
      }),
    ),
  /** Deletes a restore point and its file. */
  deleteRestorePoint: procedure
    .input(restorePointIdInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const point = await findRestorePoint(ctx.db, input.restorePointId);
        await guardBase(ctx, point.baseId, "manage");
        await deleteRestorePoint(ctx.db, ctx.files, point.id, (error) =>
          ctx.req.log.error({ err: error }, "restore point file delete failed"),
        );
        return { ok: true as const };
      }),
    ),
};
