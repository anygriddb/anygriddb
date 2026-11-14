import {
  ROLES,
  isComputedType,
  addColumnInputSchema,
  airtableBaseId,
  startAirtableImportInputSchema,
  addLookupInputSchema,
  addRelationInputSchema,
  addRollupInputSchema,
  AppError,
  BASE_TEMPLATES,
  type Binding,
  buildCountRows,
  buildReadRows,
  clearTableAclInputSchema,
  columnFromAddInput,
  createBaseInputSchema,
  createTableInputSchema,
  createViewInputSchema,
  createWebhookInputSchema,
  deleteBaseInputSchema,
  deleteColumnInputSchema,
  deleteTableInputSchema,
  deleteViewInputSchema,
  deleteWebhookInputSchema,
  describeColumns,
  duplicateColumnInputSchema,
  duplicateBaseInputSchema,
  duplicateTableInputSchema,
  duplicateViewInputSchema,
  embedOriginsInputSchema,
  effectiveTableRole,
  type EngineCatalog,
  exportSnapshotJobInputSchema,
  type FilterGroup,
  findTemplate,
  formatFormula,
  getTableAclInputSchema,
  importSnapshotJobInputSchema,
  listViewsInputSchema,
  listWebhooksInputSchema,
  previewConversionInputSchema,
  purgeTrashInputSchema,
  reorderColumnsInputSchema,
  reorderTablesInputSchema,
  reorderViewsInputSchema,
  restoreInputSchema,
  retryDeliveryInputSchema,
  roleAllows,
  roleFor,
  selectOptionNames,
  setPrimaryColumnInputSchema,
  setTableAclInputSchema,
  tableActivityInputSchema,
  trashListInputSchema,
  updateBaseInputSchema,
  updateColumnInputSchema,
  updateTableInputSchema,
  updateViewInputSchema,
  updateWebhookInputSchema,
  viewAsInputSchema,
  webhookDeliveriesInputSchema,
  webhookIdInputSchema,
} from "@anygriddb/core";
import { z } from "zod";
import { loadBindings } from "../auth/access.js";
import {
  clearTableAcl,
  listTableAcls,
  readerAccess,
  readerEngine,
  setTableAcl,
} from "../data/acl.js";
import { insertComputed } from "../data/computed.js";
import { applyTemplate, duplicateColumn } from "../data/data-ops.js";
import { enqueueJob } from "../jobs.js";
import {
  createInvitation,
  assertMemberDomain,
  createShare,
  listInvitations,
  listShares,
  listTableAccess,
  revokeInvitation,
  revokeShare,
  setTableRole,
  shareViewId,
} from "../data/sharing.js";
import { readMailVoice } from "../settings.js";
import { listOpenAccess } from "../data/emergency-access.js";
import { invitationMailBody, invitationMailSubject } from "../mail-i18n.js";
import { resolveSmtp } from "../integrations/smtp.js";
import { sendMail, smtpReady } from "../mail.js";
import {
  assembleEngine,
  columnConfig,
  loadCatalogRows,
  loadEngine,
  sortColumns,
  sourceEngine,
  type CatalogRows,
} from "../data/engine.js";
import {
  grantInputSchema,
  grantMember,
  isMember,
  listMembers,
  membersInputSchema,
  revokeInputSchema,
  revokeMember,
} from "../data/members.js";
import { listGroupRoles, listGroups, setGroupRole } from "../scim/groups.js";
import { addRelation } from "../data/relations.js";
import {
  countVisibleRows,
  listCollaborators,
  readPage,
  safeTimeZone,
  visibleFields,
} from "../data/rows.js";
import { liveBase, liveColumnNames, liveTable } from "../data/live.js";
import {
  createFolder,
  createFolderInputSchema,
  deleteFolder,
  deleteFolderInputSchema,
  listFolders,
  moveTableToFolder,
  moveTableToFolderInputSchema,
  reorderFolderTables,
  reorderFolderTablesInputSchema,
  reorderFolders,
  reorderFoldersInputSchema,
  updateFolder,
  updateFolderInputSchema,
} from "../data/folders.js";
import {
  addColumn,
  insertBase,
  insertTable,
  previewConversion,
  reorderColumns,
  reorderTables,
  setPrimaryColumn,
  updateBase,
  updateColumn,
  updateTable,
} from "../data/schema-ops.js";
import { removeBase } from "../data/tables.js";
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
  trashBase,
  trashColumn,
  trashTable,
  trashedColumnTable,
} from "../data/trash.js";
import {
  canEditView,
  createView,
  duplicateView,
  listViews,
  loadView,
  reorderViews,
  trashView,
  updateView,
} from "../data/views.js";
import { publishCatalog } from "../realtime/channels.js";
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  deliveryWebhookId,
  listDeliveries,
  retryDelivery,
  testWebhook,
  updateWebhook,
  webhookTableId,
} from "../webhooks.js";
import type { Context } from "./context.js";
import {
  authorize,
  guardBase,
  guardTable,
  handle,
  readableTables,
} from "./guard.js";
import { procedure, requestNames, t } from "./init.js";
import { queueDeps } from "./jobs-router.js";
import {
  calendarFeedOf,
  renewCalendarFeed,
  revokeCalendarFeed,
} from "../data/calendar-feeds.js";
import { encryptSecret } from "../auth/crypto.js";

function baseIndex(rows: CatalogRows): Map<string, string> {
  return new Map(rows.tables.map((table) => [table.id, table.baseId]));
}

/** Public shape of a table's columns, with the kind each one reads as. */
export function publicColumns(engine: EngineCatalog, rows: CatalogRows) {
  const kinds = new Map(
    describeColumns(engine).map((column) => [column.name, column]),
  );
  const access = engine.access;
  // A field the reader may not see is left out, as if it did not exist.
  const own = sortColumns(
    rows.columns.filter(
      (column) =>
        column.tableId === engine.table.id &&
        !access?.hidden(engine.table.id, column.name),
    ),
  );
  const refs = own.map((column) => ({
    name: column.name,
    label: column.label,
  }));
  const tableRow = rows.tables.find((table) => table.id === engine.table.id);
  /**
   * A client's inverse link writes the other table's foreign key: it takes
   * changes when that table takes edits and its key may be written.
   */
  const inverseWritable = (name: string): boolean => {
    const relation = engine.table.columns.find(
      (item) => item.name === name,
    )?.relation;
    if (
      relation?.direction !== "inverse" ||
      relation.kind !== "one_to_many" ||
      !relation.fkColumn
    ) {
      return false;
    }
    const target = rows.tables.find(
      (table) => table.id === relation.targetTableId,
    );
    const key = rows.columns.find(
      (item) =>
        item.tableId === relation.targetTableId &&
        item.physicalName === relation.fkColumn,
    );
    return Boolean(
      target?.externalUpdate &&
      key?.externalWritable &&
      !engine.tables.get(relation.targetTableId)?.external?.synced,
    );
  };
  return own.map((column) => {
    const config = columnConfig(column);
    const described = kinds.get(column.name);
    const relation = rows.relations.find(
      (item) => item.fromColumnId === column.id,
    );
    const engineColumn = engine.table.columns.find(
      (item) => item.id === column.id,
    );
    return {
      id: column.id,
      name: column.name,
      label: column.label,
      description: column.description,
      fieldType: column.fieldType,
      position: column.position,
      isPrimary: column.isPrimary,
      isUnique: column.isUnique,
      requireReason: column.requireReason,
      required: column.required,
      /**
       * `read` when a field rule lets the reader see but not change it, or
       * when a client's column takes no writes: a type AnyGridDB cannot
       * write back exactly, or a right the source's account lacks.
       */
      access:
        access?.readOnly(engine.table.id, column.name) ||
        // A synced table is a copy (ADR 0034): nothing is written there.
        (engine.table.external?.synced && !isComputedType(column.fieldType)) ||
        (engine.table.storage === "external" &&
          !isComputedType(column.fieldType) &&
          !column.externalSide &&
          !inverseWritable(column.name) &&
          (!column.externalWritable || !tableRow?.externalUpdate))
          ? ("read" as const)
          : ("write" as const),
      /** A field AnyGridDB added to a client's table (ADR 0032). */
      side: column.externalSide,
      /**
       * Enrichment without a side schema: values in the control plane
       * (ADR 0046). Sort and group are refused; filters are limited.
       */
      controlPlane:
        engine.table.columns.find((item) => item.name === column.name)?.physical
          ?.controlPlane === true,
      /**
       * A client's column a new row may fill: its type is written back
       * exactly. Native fields follow `access`.
       */
      insertable:
        engine.table.storage === "external"
          ? !engine.table.external?.synced &&
            column.externalInsertable &&
            !access?.readOnly(engine.table.id, column.name)
          : !access?.readOnly(engine.table.id, column.name),
      config,
      kind: described?.kind ?? "text",
      elem: described?.elem ?? null,
      error: described?.error ?? null,
      /** What the client's engine computes differently (ADR 0005). */
      limits: described?.limits ?? [],
      /** A lookup's or a rollup's durations: the format to show them in. */
      duration: described?.duration ?? null,
      formulaSource: config.expr ? formatFormula(config.expr, refs) : null,
      relation: relation
        ? {
            kind: relation.kind,
            targetTableId: relation.toTableId,
            direction: engineColumn?.relation?.direction ?? "forward",
            inverseColumnId: relation.inverseColumnId,
          }
        : null,
      /** Pre-v2 fields, kept until every client reads `config`. */
      formula: config.expr ?? null,
      options:
        column.fieldType === "single_select" ||
        column.fieldType === "multi_select"
          ? selectOptionNames(config)
          : null,
      computed:
        column.fieldType === "lookup" || column.fieldType === "rollup"
          ? {
              relation: config.relation ?? "",
              target: config.target ?? "",
              fn: config.fn ?? null,
            }
          : null,
    };
  });
}

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

/** Watched columns must exist and a filter must compile against the table. */
async function assertWebhookColumns(
  ctx: Context,
  tableId: string,
  input: { filter?: FilterGroup; watchColumns?: string[] },
): Promise<void> {
  if (!input.filter && !input.watchColumns?.length) return;
  const { engine } = await loadEngine(ctx.db, tableId, () => true);
  const names = new Set(engine.table.columns.map((column) => column.name));
  if (input.watchColumns?.some((name) => !names.has(name))) {
    throw new AppError("invalid_webhook");
  }
  if (input.filter) {
    try {
      buildReadRows(engine, { filter: input.filter, limit: 1 });
    } catch (error) {
      throw new AppError("invalid_webhook", { cause: error });
    }
  }
}

export const catalogRouter = t.router({
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
  dropColumn: procedure
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
  members: procedure.input(membersInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await guardBase(ctx, input.baseId, "manage");
      return listMembers(ctx.db, input.baseId);
    }),
  ),
  /**
   * The administrators who have this base open now without being members
   * of it (ADR 0074): who, why, until when. For those who manage the
   * base, beside its members.
   */
  openAccess: procedure.input(membersInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await guardBase(ctx, input.baseId, "manage");
      return (await listOpenAccess(ctx.db, input.baseId)).map((open) => ({
        userId: open.userId,
        displayName: open.displayName,
        reason: open.reason,
        expiresAt: open.expiresAt.toISOString(),
      }));
    }),
  ),
  grant: procedure.input(grantInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user } = await guardBase(ctx, input.baseId, "manage");
      await assertMemberDomain(ctx.db, input.email);
      await grantMember(ctx.db, user.id, input);
      return { ok: true as const };
    }),
  ),
  revoke: procedure.input(revokeInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user } = await guardBase(ctx, input.baseId, "manage");
      await revokeMember(ctx.db, user.id, input);
      // Their open sockets reconnect, and the base's channels refuse them.
      ctx.hub.closeUser(input.userId, 4000);
      return { ok: true as const };
    }),
  ),
  /** The groups the base gives a role to, and those it could. */
  groupRoles: procedure.input(membersInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await guardBase(ctx, input.baseId, "manage");
      return {
        roles: await listGroupRoles(ctx.db, input.baseId),
        groups: (await listGroups(ctx.db)).map((group) => ({
          id: group.id,
          displayName: group.displayName,
          members: group.members,
        })),
      };
    }),
  ),
  setGroupRole: procedure
    .input(
      z.object({
        baseId: z.uuid(),
        groupId: z.uuid(),
        role: z.enum(ROLES).nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "manage");
        await setGroupRole(ctx.db, user.id, input);
        return { ok: true as const };
      }),
    ),
  views: procedure.input(listViewsInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user } = await guardTable(ctx, input.tableId, "read");
      return { views: await listViews(ctx.db, input.tableId, user.id) };
    }),
  ),
  createView: procedure
    .input(createViewInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const personal = input.personal === true;
        const { user, bindings, role } = await guardTable(
          ctx,
          input.tableId,
          personal ? "read" : "write",
        );
        if (!personal && role !== "owner" && role !== "editor") {
          throw new AppError("access_denied");
        }
        const { engine } = await loadEngine(
          ctx.db,
          input.tableId,
          readableTables(bindings, new Map()),
        );
        return createView(ctx.db, engine, {
          tableId: input.tableId,
          name: input.name,
          viewType: input.viewType,
          config: input.config,
          ownerId: personal ? user.id : null,
        });
      }),
    ),
  updateView: procedure
    .input(updateViewInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        const { user, role } = await guardTable(ctx, view.tableId, "read");
        if (
          !canEditView(view, user.id, role) ||
          (input.locked !== undefined && role !== "owner")
        ) {
          throw new AppError("access_denied");
        }
        const { engine } = await loadEngine(ctx.db, view.tableId, () => true);
        return updateView(ctx.db, engine, view, input);
      }),
    ),
  duplicateView: procedure
    .input(duplicateViewInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        const { user, role } = await guardTable(ctx, view.tableId, "read");
        const personal = role !== "owner" && role !== "editor";
        if (view.ownerId && view.ownerId !== user.id) {
          throw new AppError("access_denied");
        }
        return duplicateView(
          ctx.db,
          view,
          input.name ?? (await requestNames(ctx)).copy(view.name).slice(0, 80),
          personal || view.ownerId ? user.id : null,
        );
      }),
    ),
  reorderViews: procedure
    .input(reorderViewsInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(ctx, input.tableId, "write");
        await reorderViews(ctx.db, input.tableId, input.order);
        return { ok: true as const };
      }),
    ),
  deleteView: procedure
    .input(deleteViewInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        const { user, role } = await guardTable(ctx, view.tableId, "read");
        if (!canEditView(view, user.id, role)) {
          throw new AppError("access_denied");
        }
        await trashView(ctx.db, user.id, view);
        return { ok: true as const };
      }),
    ),
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
  webhooks: procedure.input(listWebhooksInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await guardTable(ctx, input.tableId, "manage");
      return { webhooks: await listWebhooks(ctx.db, input.tableId) };
    }),
  ),
  createWebhook: procedure
    .input(createWebhookInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardTable(ctx, input.tableId, "manage");
        await assertWebhookColumns(ctx, input.tableId, input);
        return createWebhook(ctx.db, ctx.env.AUTH_ENCRYPTION_KEY, {
          ...input,
          createdBy: user.id,
        });
      }),
    ),
  updateWebhook: procedure
    .input(updateWebhookInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const tableId = await webhookTableId(ctx.db, input.webhookId);
        await guardTable(ctx, tableId, "manage");
        await assertWebhookColumns(ctx, tableId, {
          filter: input.filter ?? undefined,
          watchColumns: input.watchColumns ?? undefined,
        });
        await updateWebhook(
          ctx.db,
          ctx.env.AUTH_ENCRYPTION_KEY,
          input.webhookId,
          input,
        );
        return { ok: true as const };
      }),
    ),
  testWebhook: procedure
    .input(webhookIdInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(
          ctx,
          await webhookTableId(ctx.db, input.webhookId),
          "manage",
        );
        const { config: smtp } = await resolveSmtp(ctx.db, ctx.env);
        return testWebhook(
          {
            db: ctx.db,
            key: ctx.env.AUTH_ENCRYPTION_KEY,
            smtp,
            log: (error, message) => ctx.req.log.error({ err: error }, message),
          },
          input.webhookId,
        );
      }),
    ),
  webhookDeliveries: procedure
    .input(webhookDeliveriesInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(
          ctx,
          await webhookTableId(ctx.db, input.webhookId),
          "manage",
        );
        return {
          deliveries: await listDeliveries(
            ctx.db,
            input.webhookId,
            input.limit,
          ),
        };
      }),
    ),
  retryDelivery: procedure
    .input(retryDeliveryInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const webhookId = await deliveryWebhookId(ctx.db, input.deliveryId);
        await guardTable(
          ctx,
          await webhookTableId(ctx.db, webhookId),
          "manage",
        );
        await retryDelivery(ctx.db, input.deliveryId);
        return { ok: true as const };
      }),
    ),
  deleteWebhook: procedure
    .input(deleteWebhookInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(
          ctx,
          await webhookTableId(ctx.db, input.webhookId),
          "manage",
        );
        await deleteWebhook(ctx.db, input.webhookId);
        return { ok: true as const };
      }),
    ),
  tableAccess: procedure
    .input(z.object({ tableId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const { table } = await guardTable(ctx, input.tableId, "manage");
        return { people: await listTableAccess(ctx.db, table) };
      }),
    ),
  setTableRole: procedure
    .input(
      z.object({
        tableId: z.uuid(),
        userId: z.uuid(),
        role: z.enum(["owner", "editor", "commenter", "viewer"]).nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "manage");
        await guardBase(ctx, table.baseId, "manage");
        await setTableRole(ctx.db, user.id, table, input.userId, input.role);
        return { ok: true as const };
      }),
    ),
  invite: procedure
    .input(
      z.object({
        baseId: z.uuid(),
        email: z.email().max(254),
        role: z.enum(["owner", "editor", "commenter", "viewer"]),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "manage");
        await assertMemberDomain(ctx.db, input.email);
        // Someone already in the base changes role at once: the list of
        // members shows them to whoever manages it.
        if (await isMember(ctx.db, input.baseId, input.email)) {
          await grantMember(ctx.db, user.id, input);
          return { status: "granted" as const, token: null, mailed: false };
        }
        // Anyone else is invited, with an account or without: the answer
        // is the same, so that inviting an address does not tell whether
        // it has an account here. An account's holder finds the
        // invitation on their home page, and the mail's link works too.
        const created = await createInvitation(ctx.db, {
          ...input,
          invitedBy: user.id,
        });
        let mailed = false;
        const { config: smtp } = await resolveSmtp(ctx.db, ctx.env);
        if (smtpReady(smtp)) {
          const [base, voice] = await Promise.all([
            ctx.db
              .selectFrom("bases")
              .select("name")
              .where("id", "=", input.baseId)
              .executeTakeFirst(),
            readMailVoice(ctx.db),
          ]);
          const link = `${ctx.env.PUBLIC_URL}/invite/${created.token}`;
          const expiresDate = created.expiresAt.toISOString().slice(0, 10);
          try {
            await sendMail(smtp, voice, {
              to: input.email,
              subject: invitationMailSubject(voice, base?.name ?? ""),
              text: invitationMailBody(voice, {
                inviterName: user.displayName,
                link,
                expiresDate,
              }),
            });
            mailed = true;
          } catch (error) {
            ctx.req.log.error({ err: error }, "invitation mail failed");
          }
        }
        return { status: "invited" as const, token: created.token, mailed };
      }),
    ),
  invitations: procedure
    .input(z.object({ baseId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardBase(ctx, input.baseId, "manage");
        return { invitations: await listInvitations(ctx.db, input.baseId) };
      }),
    ),
  revokeInvitation: procedure
    .input(z.object({ baseId: z.uuid(), invitationId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardBase(ctx, input.baseId, "manage");
        await revokeInvitation(ctx.db, input.baseId, input.invitationId);
        return { ok: true as const };
      }),
    ),
  shares: procedure
    .input(z.object({ viewId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        await guardTable(ctx, view.tableId, "write");
        return { shares: await listShares(ctx.db, input.viewId) };
      }),
    ),
  createShare: procedure
    .input(
      z.object({
        viewId: z.uuid(),
        password: z.string().min(8).max(128).optional(),
        expiresInDays: z.int().min(1).max(365).optional(),
        allowCopy: z.boolean().optional(),
        embedOrigins: embedOriginsInputSchema,
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        const { user } = await guardTable(ctx, view.tableId, "write");
        if (view.ownerId) {
          throw new AppError("invalid_view");
        }
        return createShare(ctx.db, {
          viewId: view.id,
          createdBy: user.id,
          password: input.password,
          expiresAt: input.expiresInDays
            ? new Date(Date.now() + input.expiresInDays * 86_400_000)
            : undefined,
          allowCopy: input.allowCopy === true,
          embedOrigins: input.embedOrigins,
        });
      }),
    ),
  /** The person's private iCal feed of a calendar view, if any. */
  calendarFeed: procedure
    .input(z.object({ viewId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        const { user } = await guardTable(ctx, view.tableId, "read");
        return { feed: await calendarFeedOf(ctx.db, user.id, view.id) };
      }),
    ),
  /** A new feed address, shown once; the previous one stops working. */
  renewCalendarFeed: procedure
    .input(z.object({ viewId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        const { user } = await guardTable(ctx, view.tableId, "read");
        const token = await renewCalendarFeed(ctx.db, user.id, view.id);
        return { url: `${ctx.env.PUBLIC_URL}/ical/${token}.ics` };
      }),
    ),
  revokeCalendarFeed: procedure
    .input(z.object({ viewId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        const { user } = await guardTable(ctx, view.tableId, "read");
        await revokeCalendarFeed(ctx.db, user.id, view.id);
        return { ok: true as const };
      }),
    ),
  revokeShare: procedure
    .input(z.object({ shareId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(
          ctx.db,
          await shareViewId(ctx.db, input.shareId),
        );
        await guardTable(ctx, view.tableId, "write");
        await revokeShare(ctx.db, input.shareId);
        return { ok: true as const };
      }),
    ),
  /** Field and row rules for every collaborator on a table. */
  tableAcl: procedure.input(getTableAclInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await guardTable(ctx, input.tableId, "manage");
      return { rules: await listTableAcls(ctx.db, input.tableId) };
    }),
  ),
  setTableAcl: procedure
    .input(setTableAclInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "manage");
        const bindings = await loadBindings(ctx.db, input.userId);
        if (!effectiveTableRole(bindings, table.id, table.baseId)) {
          throw new AppError("unknown_account");
        }
        const known = await liveColumnNames(ctx.db, table.id);
        for (const column of input.columns) {
          if (!known.has(column.column)) throw new AppError("unknown_column");
        }
        if (input.rowFilter) {
          // A rule that does not compile would hide every row: refuse it.
          const { engine } = await loadEngine(ctx.db, table.id, () => true);
          buildCountRows(engine, { filter: input.rowFilter, me: input.userId });
        }
        await setTableAcl(ctx.db, user.id, input);
        return { ok: true as const };
      }),
    ),
  clearTableAcl: procedure
    .input(clearTableAclInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardTable(ctx, input.tableId, "manage");
        await clearTableAcl(ctx.db, user.id, input.tableId, input.userId);
        return { ok: true as const };
      }),
    ),
  /**
   * A manager's preview of what a collaborator can read: their role, each
   * field's access, their row rule, and a sample page read exactly as they
   * would read it.
   */
  viewAs: procedure.input(viewAsInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const { table } = await guardTable(ctx, input.tableId, "manage");
      const target = await ctx.db
        .selectFrom("users")
        .select(["id", "displayName", "email"])
        .where("id", "=", input.userId)
        .executeTakeFirst();
      if (!target) throw new AppError("unknown_account");
      const bindings = await loadBindings(ctx.db, input.userId);
      const role = effectiveTableRole(bindings, table.id, table.baseId);
      if (!role) throw new AppError("access_denied");
      const { engine } = await readerEngine(ctx.db, table.id, {
        userId: input.userId,
        bindings,
      });
      const access = engine.access;
      const columns = engine.table.columns.map((column) => ({
        name: column.name,
        access: access?.hidden(table.id, column.name)
          ? ("hide" as const)
          : access?.readOnly(table.id, column.name)
            ? ("read" as const)
            : ("write" as const),
      }));
      const page = await readPage(
        ctx.db,
        engine,
        {
          ...(engine.access ? { fields: visibleFields(engine) } : {}),
          limit: input.limit,
          timeZone: safeTimeZone(
            typeof ctx.req.headers["x-timezone"] === "string"
              ? ctx.req.headers["x-timezone"]
              : "UTC",
          ),
          me: input.userId,
        },
        { total: true },
      );
      return {
        user: target,
        role,
        rowFilter: access?.rowFilter(table.id) ?? null,
        columns,
        sample: {
          total: page.total ?? 0,
          rows: page.rows,
        },
      };
    }),
  ),
});

function logPublish(ctx: Context): (error: unknown) => void {
  return (error) => {
    ctx.req.log.error({ err: error }, "realtime publish failed");
  };
}
