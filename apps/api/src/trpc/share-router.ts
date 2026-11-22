import { publicConfig } from "./share-config.js";
import {
  andFilters,
  AppError,
  type CellValue,
  cellValueSchema,
  coerceCellValue,
  columnNameSchema,
  describeColumns,
  formWindow,
  ROW_ERRORS,
  viewFilter,
  visibleFormFields,
} from "@anygriddb/core";
import { z } from "zod";
import { openBaseShare, openShare as openLink } from "../data/open-share.js";
import {
  readPage,
  type RowRecord,
  safeTimeZone,
  writeColumns,
} from "../data/rows.js";
import { createRows } from "../services/rows.js";
import { publicColumns } from "./catalog-shared.js";
import type { Context } from "./context.js";
import { handle } from "./guard.js";
import { procedure, t } from "./init.js";

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);
const accessSchema = z.string().max(200).optional();
const passwordSchema = z.object({
  token: tokenSchema,
  password: z.string().max(200),
});
const readerSort = z
  .array(
    z.object({
      column: columnNameSchema,
      direction: z.enum(["asc", "desc"]),
    }),
  )
  .max(1)
  .optional();

/**
 * A reader's order replaces the view's for this request only, and only
 * for a column the link already shows. Anything else keeps the saved order.
 */
function shareSort<T extends { column: string }>(
  fields: readonly string[],
  asked: readonly T[] | undefined,
  saved: readonly T[] | undefined,
): readonly T[] | undefined {
  const kept = asked?.filter((item) => fields.includes(item.column));
  return kept && kept.length > 0 ? kept : saved;
}

/**
 * A page of rows as a link shows them: the fields it shows, the row's id
 * and number, and their formula errors. Public links have no file route:
 * an attachment's keys stay behind.
 */
function publicRows(
  rows: readonly RowRecord[],
  fields: readonly string[],
  columns: ReadonlyArray<{ name: string; fieldType: string }>,
) {
  const attachmentFields = new Set(
    columns
      .filter((column) => column.fieldType === "attachment")
      .map((column) => column.name),
  );
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).flatMap(([key, value]) => {
        if (key === "id" || key === "ag_seq" || fields.includes(key)) {
          if (attachmentFields.has(key)) return [[key, []]];
          return [[key, value]];
        }
        // Formula errors (ADR 0036), of the fields shown only.
        if (key === ROW_ERRORS && value && typeof value === "object")
          return [
            [
              key,
              Object.fromEntries(
                Object.entries(value).filter(([name]) => fields.includes(name)),
              ),
            ],
          ];
        return [];
      }),
    ),
  );
}

function openShare(
  ctx: Context,
  input: { token: string; password?: string; access?: string },
  action: "read" | "write",
) {
  return openLink(
    { db: ctx.db, encryptionKey: ctx.env.AUTH_ENCRYPTION_KEY },
    input,
    action,
  );
}

export const shareRouter = t.router({
  /**
   * A link to a whole base (ROADMAP row 93): its name, and each of its
   * tables the link's creator reads, with the fields they see. Locked
   * until the password, when it has one.
   */
  openBase: procedure
    .input(z.object({ token: tokenSchema, access: accessSchema }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const opened = await openBaseShare(
          { db: ctx.db, encryptionKey: ctx.env.AUTH_ENCRYPTION_KEY },
          input,
        );
        if (opened.locked) {
          return {
            locked: true as const,
            access: null,
            base: null,
            tables: [],
          };
        }
        const tables = [];
        for (const table of opened.tables) {
          const { engine, rows, fields } = await opened.read(table.id);
          tables.push({
            id: table.id,
            name: table.name,
            columns: publicColumns(engine, rows)
              .filter((column) => fields.includes(column.name))
              .map((column) => ({
                ...column,
                formulaSource: null,
                formula: null,
              })),
          });
        }
        return {
          locked: false as const,
          access: opened.access,
          base: { name: opened.base.name },
          tables,
        };
      }),
    ),
  /** A page of one table's rows through a base's link, read-only. */
  baseRows: procedure
    .input(
      z.object({
        token: tokenSchema,
        access: accessSchema,
        tableId: z.uuid(),
        offset: z.int().min(0).max(1_000_000).default(0),
        limit: z.int().min(1).max(1000).default(100),
        search: z.string().trim().min(1).max(200).optional(),
        timeZone: z.string().max(64).optional(),
        sort: readerSort,
      }),
    )
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const opened = await openBaseShare(
          { db: ctx.db, encryptionKey: ctx.env.AUTH_ENCRYPTION_KEY },
          input,
        );
        if (opened.locked) throw new AppError("unknown_share");
        const { engine, fields } = await opened.read(input.tableId);
        const page = await readPage(
          ctx.db,
          engine,
          {
            search: input.search,
            sort: shareSort(fields, input.sort, undefined),
            fields,
            offset: input.offset,
            limit: input.limit,
            timeZone: safeTimeZone(input.timeZone),
          },
          { total: true, budget: ctx.readBudget },
        );
        return {
          rows: publicRows(page.rows, fields, engine.table.columns),
          total: page.total ?? 0,
        };
      }),
    ),
  /**
   * A link's password, given once, for the proof its readings then carry.
   * It travels in a request's body: a reading is an address, which a
   * proxy on the way writes to its log.
   */
  unlock: procedure.input(passwordSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const opened = await openShare(ctx, input, "read");
      return opened.locked
        ? { locked: true as const, access: null }
        : { locked: false as const, access: opened.access };
    }),
  ),
  /** The same, for a link to a whole base. */
  unlockBase: procedure.input(passwordSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const opened = await openBaseShare(
        { db: ctx.db, encryptionKey: ctx.env.AUTH_ENCRYPTION_KEY },
        input,
      );
      return opened.locked
        ? { locked: true as const, access: null }
        : { locked: false as const, access: opened.access };
    }),
  ),
  open: procedure
    .input(z.object({ token: tokenSchema, access: accessSchema }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const opened = await openShare(ctx, input, "read");
        if (opened.locked) {
          return {
            locked: true as const,
            access: null,
            view: null,
            table: null,
            columns: [],
            allowCopy: false,
          };
        }
        const columns = publicColumns(opened.engine, opened.rows).filter(
          (column) => opened.fields.includes(column.name),
        );
        return {
          locked: false as const,
          access: opened.access,
          view: {
            name: opened.view.name,
            viewType: opened.view.viewType,
            config: publicConfig(opened.config, opened.fields),
            // Whether a form takes answers now, by the server's clock.
            window: formWindow(opened.config.form),
          },
          table: { name: opened.table.name },
          columns: columns.map((column) => ({
            ...column,
            formulaSource: null,
            formula: null,
            description: column.description,
          })),
          allowCopy: opened.share.allowCopy,
        };
      }),
    ),
  rows: procedure
    .input(
      z.object({
        token: tokenSchema,
        access: accessSchema,
        offset: z.int().min(0).max(1_000_000).default(0),
        limit: z.int().min(1).max(1000).default(100),
        search: z.string().trim().min(1).max(200).optional(),
        timeZone: z.string().max(64).optional(),
        sort: readerSort,
      }),
    )
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const opened = await openShare(ctx, input, "read");
        if (opened.locked || opened.view.viewType === "form") {
          throw new AppError("unknown_share");
        }
        const page = await readPage(
          ctx.db,
          opened.engine,
          {
            filter: andFilters(viewFilter(opened.config)),
            sort: shareSort(opened.fields, input.sort, opened.config.sort),
            search: input.search,
            fields: opened.fields,
            offset: input.offset,
            limit: input.limit,
            timeZone: safeTimeZone(input.timeZone),
          },
          { total: true, budget: ctx.readBudget },
        );
        return {
          rows: publicRows(
            page.rows,
            opened.fields,
            opened.engine.table.columns,
          ),
          total: page.total ?? 0,
        };
      }),
    ),
  submit: procedure
    .input(
      z.object({
        token: tokenSchema,
        access: accessSchema,
        values: z.record(
          columnNameSchema,
          z.union([cellValueSchema, z.string().max(20_000)]),
        ),
        // The person's zone, for conditions on relative dates.
        timeZone: z.string().max(64).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const opened = await openShare(ctx, input, "write");
        if (opened.locked || opened.view.viewType !== "form") {
          throw new AppError("unknown_share");
        }
        // Outside the time its maker set, the form takes nothing, whoever
        // calls and whatever page they kept open.
        if (formWindow(opened.config.form) !== "open") {
          throw new AppError("form_closed");
        }
        const columns = writeColumns(opened.engine).filter(
          (column) =>
            opened.fields.includes(column.name) &&
            !opened.engine.access?.readOnly(
              opened.engine.table.id,
              column.name,
            ),
        );
        const required = new Set(
          (opened.config.form?.fields ?? [])
            .filter((field) => field.required)
            .map((field) => field.column),
        );
        // A field the answers do not show is neither required nor written,
        // whoever calls: the browser decides with the same rules.
        const rules = opened.config.form?.fields?.length
          ? opened.config.form.fields
          : opened.fields.map((column) => ({ column }));
        const shown = new Set(
          visibleFormFields(rules, input.values, {
            kinds: new Map(
              describeColumns(opened.engine).map((column) => [
                column.name,
                column.kind,
              ]),
            ),
            timeZone: safeTimeZone(input.timeZone),
          }),
        );
        const values: Record<string, CellValue> = {};
        for (const column of columns.filter((item) => shown.has(item.name))) {
          const raw = input.values[column.name];
          if (
            raw === undefined ||
            raw === null ||
            raw === "" ||
            (Array.isArray(raw) && raw.length === 0)
          ) {
            if (required.has(column.name)) throw new AppError("invalid_cell");
            continue;
          }
          if (column.fieldType === "user") continue;
          const value = coerceCellValue(column, raw);
          if (value === undefined) {
            throw new AppError(
              column.fieldType === "attachment"
                ? "invalid_attachment"
                : "invalid_cell",
            );
          }
          values[column.name] = value;
        }
        await createRows(
          {
            db: ctx.db,
            bus: ctx.bus,
            log: (error: unknown, message: string) =>
              ctx.req.log.error({ err: error }, message),
          },
          {
            actorId: opened.share.createdBy,
            table: opened.table,
            engine: opened.engine,
            catalog: opened.rows,
          },
          [{ values }],
          // A public form cannot ask for a reason. Its files are the ones
          // this link sent, claimed with the row (ADR 0062).
          {
            fixedReason: null,
            source: `form:${opened.share.id}`,
            stagedShareId: opened.share.id,
          },
        );
        return { ok: true as const };
      }),
    ),
});
