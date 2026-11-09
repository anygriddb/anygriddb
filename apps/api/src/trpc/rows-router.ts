import {
  addCommentInputSchema,
  andFilters,
  AppError,
  auditReadInputSchema,
  deleteCommentInputSchema,
  deleteRowInputSchema,
  deleteRowsInputSchema,
  effectiveTableRole,
  type EngineCatalog,
  importCommitInputSchema,
  importRowsInputSchema,
  insertRowInputSchema,
  insertRowsInputSchema,
  legacyFiltersToGroup,
  linkCandidatesInputSchema,
  listCommentsInputSchema,
  normalizeViewConfig,
  parseMentions,
  pruneViewConfig,
  type ReadSpec,
  restoreRowsInputSchema,
  roleAllows,
  rowsAggregateInputSchema,
  rowsGetInputSchema,
  rowsReadInputSchema,
  setLinksInputSchema,
  setStatusInputSchema,
  signRowInputSchema,
  trashInputSchema,
  updateCommentInputSchema,
  updateRowInputSchema,
  updateRowsInputSchema,
  viewFilter,
} from "@anygriddb/core";
import {
  addComment,
  commentTableId,
  deleteComment,
  listComments,
  updateComment,
} from "../data/comments.js";
import { assertJobCapacity, enqueueJob } from "../jobs.js";
import { readerEngine } from "../data/acl.js";
import { listExternalTrash, readExternalAudit } from "../sources/writes.js";
import {
  attachExternalStatuses,
  type Drift,
  readStatusEvents,
} from "../sources/statuses.js";
import { loadEngine, type CatalogRows } from "../data/engine.js";
import {
  keepStagedImport,
  loadStagedImport,
  newTableColumns,
} from "../data/import-commit.js";
import { insertTable } from "../data/schema-ops.js";
import { linkCandidates } from "../data/relations.js";
import {
  aggregateRows,
  assertFieldsWritable,
  assertRowsInScope,
  attachSignatures,
  attachmentVisible,
  exportCsv,
  listCollaborators,
  listTrash,
  parseImport,
  readAudit,
  readByIds,
  readPage,
  safeTimeZone,
  visibleFields,
  writeColumns,
  type RowRecord,
} from "../data/rows.js";
import { loadView } from "../data/views.js";
import { publishCatalog } from "../realtime/channels.js";
import {
  attachmentInputSchema,
  attachmentReadSchema,
  decodeAttachment,
} from "../storage.js";
import {
  cleanFilename,
  enrichAttachments,
  readAttachmentBase64,
  storeAttachment,
} from "../attachments.js";
import {
  commentNotifications,
  notify,
  type NotifyDeps,
} from "../notifications.js";
import {
  assertUnrestricted,
  changeStatus,
  createRows,
  deleteRows,
  importRows,
  loadRowScope,
  replaceLinks,
  restoreRows,
  signRowAs,
  updateRows,
  type RowScope,
  type RowServiceDeps,
} from "../services/rows.js";
import type { Context } from "./context.js";
import { queueDeps } from "./jobs-router.js";
import { guardBase, guardTable, handle, type TableAccess } from "./guard.js";
import { procedure, requestNames, requireUser, t } from "./init.js";
import { liveColumnNames, liveTable } from "../data/live.js";

/** AnyGridDB's own rows are named by a uuid. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The engine for the caller: their roles, and their field and row rules. */
async function engineFor(
  ctx: Context,
  access: TableAccess,
): Promise<{ engine: EngineCatalog; rows: CatalogRows }> {
  return readerEngine(ctx.db, access.table.id, {
    userId: access.user.id,
    bindings: access.bindings,
  });
}

/** What the row service needs from a request. */
function serviceDeps(ctx: Context): RowServiceDeps {
  return {
    db: ctx.db,
    bus: ctx.bus,
    log: (error, message) => ctx.req.log.error({ err: error }, message),
  };
}

function scopeOf(ctx: Context, access: TableAccess): Promise<RowScope> {
  return loadRowScope(
    ctx.db,
    { userId: access.user.id, bindings: access.bindings },
    access.table,
  );
}

/** The caller's view of a table they may write. */
async function writeScope(ctx: Context, tableId: string): Promise<RowScope> {
  return scopeOf(ctx, await guardTable(ctx, tableId, "write"));
}

export function notifyDeps(ctx: Context): NotifyDeps {
  return {
    db: ctx.db,
    bus: ctx.bus,
    smtp: ctx.env,
    webOrigin: ctx.env.PUBLIC_URL,
    log: (error, message) => ctx.req.log.error({ err: error }, message),
  };
}

async function readSpec(
  ctx: Context,
  access: TableAccess,
  input: {
    viewId?: string;
    filter?: ReadSpec["filter"];
    filters?: Parameters<typeof legacyFiltersToGroup>[0];
    search?: string;
    sort?: ReadSpec["sort"];
    groupBy?: string | ReadSpec["groupBy"];
    fields?: readonly string[];
    offset?: number;
    limit: number;
    timeZone?: string;
    ignoreViewFilter?: boolean;
  },
  engine: EngineCatalog,
): Promise<ReadSpec> {
  let viewConfig = {};
  if (input.viewId) {
    const view = await loadView(ctx.db, input.viewId);
    if (
      view.tableId !== access.table.id ||
      (view.ownerId && view.ownerId !== access.user.id)
    ) {
      throw new AppError("invalid_view");
    }
    viewConfig = pruneViewConfig(
      normalizeViewConfig(view.config, view.viewType),
      await liveColumnNames(ctx.db, access.table.id),
    );
  }
  const config = normalizeViewConfig(viewConfig);
  const groupBy =
    typeof input.groupBy === "string"
      ? [{ column: input.groupBy, direction: "asc" as const }]
      : (input.groupBy ?? (input.viewId ? config.groupBy : undefined));
  const fields = visibleFields(engine, input.fields);
  return {
    filter: andFilters(
      input.ignoreViewFilter ? undefined : viewFilter(config),
      input.filter,
      input.filters && input.filters.length > 0
        ? legacyFiltersToGroup(input.filters)
        : undefined,
    ),
    search: input.search ?? (input.viewId ? config.search : undefined),
    sort:
      input.sort ??
      (input.viewId && !input.ignoreViewFilter ? config.sort : undefined),
    groupBy,
    fields,
    offset: input.offset ?? 0,
    limit: input.limit,
    timeZone: safeTimeZone(input.timeZone),
    me: access.user.id,
  };
}

function attachmentColumns(engine: EngineCatalog): string[] {
  return engine.table.columns
    .filter((column) => column.fieldType === "attachment")
    .map((column) => column.name);
}

/**
 * Statuses, signatures, and attachment metadata, added after the SQL read.
 * A client's row gets its status from AnyGridDB's database, and `drift`
 * when a check found it changed since it was sealed (ADR 0033).
 */
async function withSignatures(
  ctx: Context,
  engine: EngineCatalog,
  rows: RowRecord[],
) {
  await enrichAttachments(ctx.db, attachmentColumns(engine), rows);
  const drifts = await attachExternalStatuses(ctx.db, engine, rows);
  const signed = await attachSignatures(ctx.db, engine.table.id, rows);
  return signed.map((row) =>
    Object.assign(row, {
      drift: drifts.get(row.id) ?? (null as Drift | null),
    }),
  );
}

async function resolveUserLookup(ctx: Context, baseId: string) {
  const people = await listCollaborators(ctx.db, baseId);
  return (text: string): string | undefined => {
    const folded = text.trim().toLowerCase();
    return people.find((person) => person.displayName.toLowerCase() === folded)
      ?.id;
  };
}

export const rowsRouter = t.router({
  read: procedure.input(rowsReadInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const access = await guardTable(ctx, input.tableId, "read");
      const { engine } = await engineFor(ctx, access);
      const spec = await readSpec(ctx, access, input, engine);
      const page = await readPage(ctx.db, engine, spec, {
        total: input.withTotal,
        exact: input.exactTotal,
      });
      return {
        rows: await withSignatures(ctx, engine, page.rows),
        // Null when the page was read without its count.
        total: page.total,
        totalEstimated: page.totalEstimated,
        groups: page.groups,
        offset: spec.offset ?? 0,
      };
    }),
  ),
  get: procedure.input(rowsGetInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const access = await guardTable(ctx, input.tableId, "read");
      const { engine } = await engineFor(ctx, access);
      const rows = await readByIds(
        ctx.db,
        engine,
        input.rowIds,
        safeTimeZone(input.timeZone),
      );
      return { rows: await withSignatures(ctx, engine, rows) };
    }),
  ),
  aggregate: procedure.input(rowsAggregateInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const access = await guardTable(ctx, input.tableId, "read");
      const { engine } = await engineFor(ctx, access);
      const spec = await readSpec(ctx, access, { ...input, limit: 1 }, engine);
      const values = await aggregateRows(ctx.db, engine, spec, input.items);
      return { values };
    }),
  ),
  insert: procedure.input(insertRowInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const scope = await writeScope(ctx, input.tableId);
      const [id] = await createRows(
        serviceDeps(ctx),
        scope,
        [{ values: input.values }],
        { reason: input.reason, source: "web" },
      );
      if (!id) throw new AppError("no_row");
      return { id };
    }),
  ),
  insertMany: procedure
    .input(insertRowsInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const scope = await writeScope(ctx, input.tableId);
        const ids = await createRows(
          serviceDeps(ctx),
          scope,
          input.rows.map((values) => ({ values })),
          { reason: input.reason, source: "web" },
        );
        return { ids };
      }),
    ),
  update: procedure.input(updateRowInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const scope = await writeScope(ctx, input.tableId);
      await updateRows(
        serviceDeps(ctx),
        scope,
        [{ rowId: input.rowId, values: input.values }],
        { reason: input.reason, source: "web" },
      );
      return { ok: true as const };
    }),
  ),
  updateMany: procedure
    .input(updateRowsInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const scope = await writeScope(ctx, input.tableId);
        const ids = await updateRows(serviceDeps(ctx), scope, input.updates, {
          reason: input.reason,
          source: "web",
        });
        return { ids };
      }),
    ),
  delete: procedure.input(deleteRowInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const scope = await writeScope(ctx, input.tableId);
      await deleteRows(serviceDeps(ctx), scope, [input.rowId], {
        reason: input.reason,
        source: "web",
      });
      return { ok: true as const };
    }),
  ),
  deleteMany: procedure
    .input(deleteRowsInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const scope = await writeScope(ctx, input.tableId);
        const ids = await deleteRows(serviceDeps(ctx), scope, input.rowIds, {
          reason: input.reason,
          source: "web",
        });
        return { ids };
      }),
    ),
  trash: procedure.input(trashInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const access = await guardTable(ctx, input.tableId, "write");
      const { engine } = await engineFor(ctx, access);
      assertUnrestricted(engine);
      // A client's rows: those deleted through AnyGridDB (ADR 0007).
      if (access.table.storage === "external") {
        return { rows: await listExternalTrash(ctx.db, engine, input.limit) };
      }
      return {
        rows: await listTrash(
          ctx.db,
          engine,
          { tableId: access.table.id, physicalName: access.table.physicalName },
          input.limit,
        ),
      };
    }),
  ),
  restore: procedure.input(restoreRowsInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const scope = await writeScope(ctx, input.tableId);
      assertUnrestricted(scope.engine);
      const ids = await restoreRows(serviceDeps(ctx), scope, input.rowIds, {
        reason: input.reason,
        source: "restore",
      });
      return { ids };
    }),
  ),
  setLinks: procedure.input(setLinksInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const scope = await writeScope(ctx, input.tableId);
      await replaceLinks(
        serviceDeps(ctx),
        scope,
        input.rowId,
        { column: input.column, targetIds: input.targetIds },
        { reason: input.reason, source: "web" },
      );
      const [row] = await readByIds(ctx.db, scope.engine, [input.rowId], "UTC");
      return { link: row?.[input.column] ?? [] };
    }),
  ),
  linkCandidates: procedure
    .input(linkCandidatesInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const access = await guardTable(ctx, input.tableId, "read");
        const { engine } = await engineFor(ctx, access);
        const column = engine.table.columns.find(
          (item) => item.name === input.column,
        );
        if (!column?.relation) {
          throw new AppError("invalid_relation");
        }
        return {
          rows: await linkCandidates(
            ctx.db,
            engine,
            column,
            input.search,
            input.limit,
          ),
        };
      }),
    ),
  setStatus: procedure.input(setStatusInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const access = await guardTable(
        ctx,
        input.tableId,
        input.status === "submitted" ? "write" : "manage",
      );
      const scope = await scopeOf(ctx, access);
      await changeStatus(
        serviceDeps(ctx),
        { ...scope, role: access.role },
        input.rowId,
        input.status,
        { source: "web" },
      );
      return { ok: true as const };
    }),
  ),
  sign: procedure.input(signRowInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const access = await guardTable(ctx, input.tableId, "manage");
      await signRowAs(serviceDeps(ctx), await scopeOf(ctx, access), input, {
        source: "web",
      });
      return { ok: true as const };
    }),
  ),
  audit: procedure.input(auditReadInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const access = await guardTable(ctx, input.tableId, "read");
      const { engine } = await engineFor(ctx, access);
      await assertRowsInScope(ctx.db, engine, [input.recordId]);
      const rules = engine.access;
      const hidden = (name: string) =>
        rules !== undefined &&
        name !== "id" &&
        !name.startsWith("ag_") &&
        rules.hidden(input.tableId, name);
      // A client's row: the writes made through AnyGridDB (ADR 0007).
      if (access.table.storage === "external") {
        const writes = await readExternalAudit(
          ctx.db,
          input.tableId,
          input.recordId,
          hidden,
        );
        const statuses = await readStatusEvents(
          ctx.db,
          input.tableId,
          input.recordId,
          hidden,
        );
        return {
          events: [
            ...writes.map((event) => ({
              ...event,
              fingerprint: null as string | null,
              missing: false,
            })),
            ...statuses,
          ]
            .sort((left, right) =>
              right.occurredAt.localeCompare(left.occurredAt),
            )
            .slice(0, 200),
        };
      }
      if (!UUID.test(input.recordId)) return { events: [] };
      return {
        events: (
          await readAudit(ctx.db, input.tableId, input.recordId, hidden)
        ).map((event) => ({
          ...event,
          state: null,
          fingerprint: null as string | null,
          missing: false,
        })),
      };
    }),
  ),
  export: procedure.input(rowsReadInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const access = await guardTable(ctx, input.tableId, "read");
      const { engine } = await engineFor(ctx, access);
      const spec = await readSpec(ctx, access, input, engine);
      const collected: RowRecord[] = [];
      for (let offset = 0; offset < 100_000; offset += 1000) {
        const page = await readPage(
          ctx.db,
          engine,
          { ...spec, offset, limit: 1000, groupBy: undefined },
          { total: false },
        );
        collected.push(...page.rows);
        if (page.rows.length < 1000) {
          break;
        }
      }
      await enrichAttachments(ctx.db, attachmentColumns(engine), collected);
      return { csv: exportCsv(engine, collected, spec.fields) };
    }),
  ),
  import: procedure.input(importRowsInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const scope = await writeScope(ctx, input.tableId);
      const records = parseImport(
        scope.engine,
        input.csv,
        await resolveUserLookup(ctx, scope.table.baseId),
      );
      const ids = await importRows(serviceDeps(ctx), scope, records, {
        reason: input.reason,
        source: "import",
      });
      return { inserted: ids.length };
    }),
  ),
  /**
   * Writes a file staged by `POST /api/import/preview`. A new table takes
   * its columns from the mapping; an existing one may get new columns and
   * select options when the caller manages it.
   */
  importCommit: procedure
    .input(importCommitInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        let access: TableAccess;
        let created: string[] | undefined;
        let canManage: boolean;
        await assertJobCapacity(ctx.db, (await requireUser(ctx)).id);
        if (input.target.kind === "new") {
          const { user } = await guardBase(ctx, input.target.baseId, "manage");
          const staged = await loadStagedImport(
            ctx.db,
            ctx.files,
            input.importId,
            user.id,
          );
          if (
            input.mapping.some((entry) => entry.source >= staged.headers.length)
          ) {
            throw new AppError("invalid_mapping");
          }
          const columns = newTableColumns(staged, input.mapping);
          const table = await insertTable(ctx.db, user.id, {
            baseId: input.target.baseId,
            name: input.target.name,
            columns,
            viewName: (await requestNames(ctx)).grid,
          });
          access = await guardTable(ctx, table.id, "write");
          const { rows } = await loadEngine(ctx.db, table.id, () => true);
          created = rows.columns
            .filter((column) => column.tableId === table.id)
            .sort((a, b) => a.position - b.position)
            .map((column) => column.name);
          canManage = true;
        } else {
          access = await guardTable(ctx, input.target.tableId, "write");
          canManage = roleAllows(
            effectiveTableRole(
              access.bindings,
              access.table.id,
              access.table.baseId,
            ),
            "manage",
          );
          const { engine } = await engineFor(ctx, access);
          const writable = new Set(
            writeColumns(engine).map((column) => column.name),
          );
          if (
            input.mapping.some(
              (entry) => entry.column && !writable.has(entry.column),
            )
          ) {
            throw new AppError("invalid_mapping");
          }
          assertFieldsWritable(
            engine,
            input.mapping.flatMap((entry) =>
              entry.column ? [entry.column] : [],
            ),
          );
          // Updates by key would reach rows outside a row rule.
          if (
            input.upsertSource !== undefined &&
            engine.access?.rowFilter(engine.table.id)
          ) {
            throw new AppError("access_denied");
          }
        }
        // The file must still be staged: fail now rather than in the worker.
        await loadStagedImport(
          ctx.db,
          ctx.files,
          input.importId,
          access.user.id,
        );
        await keepStagedImport(ctx.db, input.importId);
        if (
          !canManage &&
          input.mapping.some((entry) => entry.create && !created)
        ) {
          throw new AppError("access_denied");
        }
        const job = await enqueueJob(queueDeps(ctx), {
          kind: "import",
          userId: access.user.id,
          baseId: access.table.baseId,
          tableId: access.table.id,
          input: {
            importId: input.importId,
            tableId: access.table.id,
            mapping: input.mapping,
            upsertSource: input.upsertSource,
            addOptions: input.addOptions,
            reason: input.reason,
            created,
          },
        });
        if (created) {
          await publishCatalog(ctx.bus, access.table.baseId, (error) => {
            ctx.req.log.error({ err: error }, "realtime publish failed");
          });
        }
        return { jobId: job.id, tableId: access.table.id };
      }),
    ),
  comments: procedure.input(listCommentsInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const access = await guardTable(ctx, input.tableId, "read");
      const { engine } = await engineFor(ctx, access);
      await assertRowsInScope(ctx.db, engine, [input.rowId]);
      return {
        comments: await listComments(ctx.db, input.tableId, input.rowId),
      };
    }),
  ),
  commentCounts: procedure
    .input(rowsGetInputSchema.pick({ tableId: true, rowIds: true }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(ctx, input.tableId, "read");
        const { countComments } = await import("../data/comments.js");
        return {
          counts: await countComments(ctx.db, input.tableId, input.rowIds),
        };
      }),
    ),
  addComment: procedure
    .input(addCommentInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const access = await guardTable(ctx, input.tableId, "comment");
        const { engine } = await engineFor(ctx, access);
        await assertRowsInScope(ctx.db, engine, [input.rowId]);
        const created = await addComment(ctx.db, {
          tableId: input.tableId,
          rowId: input.rowId,
          authorId: access.user.id,
          body: input.body,
          parentId: input.parentId,
        });
        const parent = input.parentId
          ? await ctx.db
              .selectFrom("comments")
              .select("authorId")
              .where("id", "=", input.parentId)
              .executeTakeFirst()
          : undefined;
        await notify(
          notifyDeps(ctx),
          commentNotifications({
            tableId: input.tableId,
            rowId: input.rowId,
            commentId: created.id,
            authorId: access.user.id,
            mentioned: parseMentions(input.body),
            parentAuthorId: parent?.authorId,
          }),
        );
        return created;
      }),
    ),
  updateComment: procedure
    .input(updateCommentInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const access = await guardTable(
          ctx,
          await commentTableId(ctx.db, input.commentId),
          "comment",
        );
        const before = await ctx.db
          .selectFrom("comments")
          .select(["body", "rowId"])
          .where("id", "=", input.commentId)
          .executeTakeFirst();
        await updateComment(
          ctx.db,
          input.commentId,
          access.user.id,
          input.body,
        );
        if (before) {
          await notify(
            notifyDeps(ctx),
            commentNotifications({
              tableId: access.table.id,
              rowId: before.rowId,
              commentId: input.commentId,
              authorId: access.user.id,
              mentioned: parseMentions(input.body),
              alreadyMentioned: parseMentions(before.body),
            }),
          );
        }
        return { ok: true as const };
      }),
    ),
  deleteComment: procedure
    .input(deleteCommentInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const access = await guardTable(
          ctx,
          await commentTableId(ctx.db, input.commentId),
          "comment",
        );
        await deleteComment(
          ctx.db,
          input.commentId,
          access.user.id,
          access.role === "owner",
        );
        return { ok: true as const };
      }),
    ),
});

export const attachmentsRouter = t.router({
  get: procedure.input(attachmentReadSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const access = await guardTable(ctx, input.tableId, "read");
      const { engine } = await engineFor(ctx, access);
      const column = engine.table.columns.find(
        (item) => item.name === input.column && item.fieldType === "attachment",
      );
      if (
        !column ||
        !(await attachmentVisible(ctx.db, engine, input.key, column.name))
      ) {
        throw new AppError("invalid_attachment");
      }
      return readAttachmentBase64(ctx.files, input.key);
    }),
  ),
  put: procedure.input(attachmentInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const access = await guardTable(ctx, input.tableId, "write");
      const body = decodeAttachment(input.contentBase64);
      const stored = await storeAttachment(ctx.db, ctx.files, {
        tableId: input.tableId,
        userId: access.user.id,
        filename: cleanFilename(input.filename),
        bytes: body,
      });
      return { key: stored.key };
    }),
  ),
});

export async function tablesById(ctx: Context, ids: readonly string[]) {
  return ids.length === 0
    ? []
    : ctx.db
        .selectFrom("dataTables")
        .selectAll()
        .where("id", "in", [...ids])
        .where(liveTable())
        .execute();
}
