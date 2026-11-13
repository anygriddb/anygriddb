import {
  andFilters,
  AppError,
  type CellValue,
  cellValueSchema,
  coerceCellValue,
  columnNameSchema,
  describeColumns,
  ROW_ERRORS,
  type ViewConfig,
  viewFilter,
  visibleFormFields,
} from "@anygriddb/core";
import { z } from "zod";
import { openShare as openLink } from "../data/open-share.js";
import { readPage, safeTimeZone, writeColumns } from "../data/rows.js";
import { createRows } from "../services/rows.js";
import { publicColumns } from "./catalog-router.js";
import type { Context } from "./context.js";
import { handle } from "./guard.js";
import { procedure, t } from "./init.js";

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);
const accessSchema = z.string().max(200).optional();

const DISPLAY_KEYS = [
  "fieldOrder",
  "hiddenFields",
  "columnWidths",
  "rowHeight",
  "stackColumn",
  "coverColumn",
  "coverFit",
  "titleColumn",
  "cardFields",
  "startColumn",
  "endColumn",
  "timelineScale",
  "form",
] as const;

/** Display settings only: filter values and other internals stay private. */
function publicConfig(config: ViewConfig): Partial<ViewConfig> {
  return Object.fromEntries(
    DISPLAY_KEYS.flatMap((key) =>
      config[key] === undefined ? [] : [[key, config[key]]],
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
  open: procedure
    .input(
      z.object({
        token: tokenSchema,
        password: z.string().max(200).optional(),
        access: accessSchema,
      }),
    )
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
            config: publicConfig(opened.config),
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
            sort: opened.config.sort,
            search: input.search,
            fields: opened.fields,
            offset: input.offset,
            limit: input.limit,
            timeZone: safeTimeZone(input.timeZone),
          },
          { total: true },
        );
        // Public shares have no file route: do not leak raw attachment keys.
        const attachmentFields = new Set(
          opened.engine.table.columns
            .filter((column) => column.fieldType === "attachment")
            .map((column) => column.name),
        );
        const rows = page.rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).flatMap(([key, value]) => {
              if (
                key === "id" ||
                key === "ag_seq" ||
                opened.fields.includes(key)
              ) {
                if (attachmentFields.has(key)) return [[key, []]];
                return [[key, value]];
              }
              // Formula errors (ADR 0036), of the fields shown only.
              if (key === ROW_ERRORS && value && typeof value === "object")
                return [
                  [
                    key,
                    Object.fromEntries(
                      Object.entries(value).filter(([name]) =>
                        opened.fields.includes(name),
                      ),
                    ),
                  ],
                ];
              return [];
            }),
          ),
        );
        return { rows, total: page.total ?? 0 };
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
