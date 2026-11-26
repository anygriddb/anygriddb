import {
  AppError,
  type Binding,
  fillSecrets,
  rowIdSchema,
  secretNames,
  ceilingOf,
} from "@anygriddb/core";
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
import {
  type OutboundAnswer,
  outboundFailureText,
  requestOutbound,
} from "../outbound/index.js";
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

/** Calls one script may make to addresses outside the instance. */
export const SCRIPT_REQUESTS = 10;
/** What one such call may be answered. */
export const SCRIPT_ANSWER_BYTES = ceilingOf("automation.script_answer_bytes");

/** Headers a request sets itself, or that would change where it goes. */
const KEPT_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "expect",
  "te",
  "trailer",
  "keep-alive",
]);

/** What `fetch` takes: an address, and what a plain request carries. */
const requestSchema = z
  .object({
    url: z.string().min(1).max(2_000),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    headers: z
      .record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(4_000))
      .refine((headers) => Object.keys(headers).length <= 30)
      .default({}),
    body: z.string().optional(),
  })
  .strict();

/** A secret as a run holds it: where it may go, and what it is. */
export type ScriptSecret = { host: string; value: string };

/** The host a request goes to, or nothing when its address is not one. */
function hostOf(address: string): string | undefined {
  try {
    const url = new URL(address);
    return url.protocol === "https:" ? url.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

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
    /** The automation's secrets, by name: each goes to its host alone. */
    secrets?: ReadonlyMap<string, ScriptSecret>;
    /** How a request leaves: `requestOutbound`, unless a test says otherwise. */
    request?: typeof requestOutbound;
  },
): ScriptHost {
  let requests = 0;
  /**
   * One call to an address outside the instance (ADR 0101): public HTTPS
   * only, as a webhook's. A secret is put where the script wrote its
   * name, and only in a request to the host it is kept for; the script
   * never holds it.
   */
  const call = async (args: unknown): Promise<OutboundAnswer> => {
    const input = read(requestSchema, args);
    if (
      Object.keys(input.headers).some((name) =>
        KEPT_HEADERS.has(name.toLowerCase()),
      )
    ) {
      throw new AppError("invalid_script_request");
    }
    // The address as written, its secrets not yet in it: where it goes
    // must be plain to read before any secret is.
    const host = hostOf(input.url);
    if (!host) throw new AppError("invalid_script_request");
    const texts = [
      input.url,
      ...Object.values(input.headers),
      input.body ?? "",
    ];
    const allowed = new Map<string, string>();
    for (const name of texts.flatMap((text) => secretNames(text))) {
      const secret = context.secrets?.get(name);
      if (!secret) throw new AppError("unknown_secret", name);
      if (secret.host !== host) {
        throw new AppError("secret_for_another_host", name);
      }
      allowed.set(name, secret.value);
    }
    const fill = (text: string): string => {
      const filled = fillSecrets(text, allowed);
      if ("missing" in filled)
        throw new AppError("unknown_secret", filled.missing);
      return filled.text;
    };
    const url = fill(input.url);
    // A secret's value cannot move the request to another host.
    if (hostOf(url) !== host) throw new AppError("invalid_script_request");
    if (requests >= SCRIPT_REQUESTS) {
      throw new AppError("script_requests_exhausted");
    }
    const headers = Object.fromEntries(
      Object.entries(input.headers).map(([name, value]) => [name, fill(value)]),
    );
    // A header is one line: a value that holds another is not sent.
    if (Object.values(headers).some((value) => /[\r\n\0]/.test(value))) {
      throw new AppError("invalid_script_request");
    }
    requests += 1;
    const named = Object.keys(headers).some(
      (name) => name.toLowerCase() === "user-agent",
    );
    try {
      return await (context.request ?? requestOutbound)({
        url,
        method: input.method,
        // Said to be an automation's, as its other calls are, unless the
        // script says who it is.
        headers: named
          ? headers
          : { "user-agent": "AnyGridDB-Automation/1", ...headers },
        ...(input.body === undefined ? {} : { body: fill(input.body) }),
        maxBytes: SCRIPT_ANSWER_BYTES,
      });
    } catch (error) {
      // A call that got no answer is the script's to handle, in the
      // words a webhook's delivery uses: a private address, a name that
      // does not resolve, a timeout. Nothing of the failure itself.
      throw new AppError("script_request_failed", outboundFailureText(error), {
        cause: error,
      });
    }
  };
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
      case "http.request":
        return call(args);
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
