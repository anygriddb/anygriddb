import { AppError, type Binding, rowIdSchema } from "@anygriddb/core";
import { z } from "zod";
import type { TableRow } from "../data/engine.js";
import { liveTable } from "../data/live.js";
import {
  type Actor,
  createRecords,
  deleteRecords,
  getRecord,
  listRecords,
  type PublicApiDeps,
  updateRecords,
  type WriteOrigin,
} from "../public-api/index.js";
import type { ScriptHost } from "./sandbox.js";

/** A table of the automation's base, by its id or by its name. */
const tableSchema = z.string().trim().min(1).max(200);
const fieldsSchema = z.record(z.string().max(100), z.unknown());

/** What `records.list` takes: the public API's query, written as values. */
const listSchema = z
  .object({
    table: tableSchema,
    query: z
      .object({
        limit: z.int().min(1).max(1000).optional(),
        offset: z.int().min(0).max(10_000_000).optional(),
        view: z.uuid().optional(),
        /** `name` or `-name`, comma-separated, or a list of them. */
        sort: z
          .union([z.string().max(500), z.array(z.string().max(100)).max(5)])
          .optional(),
        /** A filter group, as the public API reads it. */
        filter: z.record(z.string(), z.unknown()).optional(),
        search: z.string().trim().min(1).max(200).optional(),
        fields: z.array(z.string().max(100)).max(200).optional(),
        timeZone: z.string().max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const getSchema = z.object({ table: tableSchema, id: rowIdSchema }).strict();

const createSchema = z
  .object({
    table: tableSchema,
    fields: z.union([fieldsSchema, z.array(fieldsSchema).min(1).max(100)]),
  })
  .strict();

const updateSchema = z
  .object({ table: tableSchema, id: rowIdSchema, fields: fieldsSchema })
  .strict();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a script sent, read by `schema`; anything else is refused. */
function read<Schema extends z.ZodType>(
  schema: Schema,
  args: unknown,
): z.infer<Schema> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new AppError("invalid_input");
  return parsed.data;
}

/**
 * The author's roles on one base and its tables, and no other: whatever
 * a script names, it cannot leave the base its automation lives in.
 */
export function bindingsWithin(
  bindings: readonly Binding[],
  baseId: string,
  tableIds: ReadonlySet<string>,
): Binding[] {
  return bindings.filter(
    (binding) =>
      (binding.scope === "base" && binding.scopeId === baseId) ||
      (binding.scope === "table" && tableIds.has(binding.scopeId)),
  );
}

/**
 * What a script may ask of the instance (ADR 0099): the records of its
 * automation's base, read and written by the public API's own
 * operations, as the automation's author. Their roles, and their field
 * and row rules, decide each call as they decide a request of theirs; a
 * write is on the trail under the automation's name.
 */
export function scriptHost(
  deps: PublicApiDeps,
  context: {
    /** The automation's author, with their roles as they are now. */
    author: Actor;
    baseId: string;
    origin: WriteOrigin;
  },
): ScriptHost {
  let tables: Promise<TableRow[]> | undefined;
  const baseTables = () =>
    (tables ??= deps.db
      .selectFrom("dataTables")
      .selectAll()
      .where("baseId", "=", context.baseId)
      .where(liveTable())
      .execute());
  /** The table a script named, and the author as they stand in this base. */
  const resolve = async (
    named: string,
  ): Promise<{ tableId: string; actor: Actor }> => {
    const list = await baseTables();
    const table =
      (UUID.test(named)
        ? list.find((item) => item.id === named.toLowerCase())
        : undefined) ?? list.find((item) => item.name === named);
    if (!table) throw new AppError("unknown_table", named.slice(0, 100));
    return {
      tableId: table.id,
      actor: {
        user: context.author.user,
        bindings: bindingsWithin(
          context.author.bindings,
          context.baseId,
          new Set(list.map((item) => item.id)),
        ),
      },
    };
  };
  return async (name, args) => {
    switch (name) {
      case "records.list": {
        const input = read(listSchema, args);
        const { tableId, actor } = await resolve(input.table);
        const query = input.query ?? {};
        return listRecords(deps, actor, tableId, {
          ...query,
          sort: Array.isArray(query.sort) ? query.sort.join(",") : query.sort,
          filter: query.filter ? JSON.stringify(query.filter) : undefined,
          fields: query.fields?.join(","),
        });
      }
      case "records.get": {
        const input = read(getSchema, args);
        const { tableId, actor } = await resolve(input.table);
        try {
          return await getRecord(deps, actor, tableId, input.id);
        } catch (error) {
          // A record that is not there, or not the author's to see.
          if (error instanceof AppError && error.code === "not_found") {
            return null;
          }
          throw error;
        }
      }
      case "records.create": {
        const input = read(createSchema, args);
        const { tableId, actor } = await resolve(input.table);
        const many = Array.isArray(input.fields);
        const list = Array.isArray(input.fields)
          ? input.fields
          : [input.fields];
        const made = await createRecords(
          deps,
          actor,
          tableId,
          { records: list.map((fields) => ({ fields })), typecast: true },
          undefined,
          context.origin,
        );
        return many ? made.records : made.records[0];
      }
      case "records.update": {
        const input = read(updateSchema, args);
        const { tableId, actor } = await resolve(input.table);
        const updated = await updateRecords(
          deps,
          actor,
          tableId,
          {
            records: [{ id: input.id, fields: input.fields }],
            typecast: true,
          },
          undefined,
          context.origin,
        );
        return updated.records[0];
      }
      case "records.delete": {
        const input = read(getSchema, args);
        const { tableId, actor } = await resolve(input.table);
        const deleted = await deleteRecords(
          deps,
          actor,
          tableId,
          [input.id],
          undefined,
          context.origin,
        );
        return deleted.records[0];
      }
      default:
        throw new AppError("invalid_input");
    }
  };
}
