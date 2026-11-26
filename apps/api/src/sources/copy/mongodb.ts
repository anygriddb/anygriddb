/**
 * A database that speaks the MongoDB wire protocol (ADR 0088): each
 * collection is a table, each document a row named by its `_id`, each
 * top-level field a column. A field that holds a document or a list is
 * kept whole, as JSON.
 *
 * The connection goes to the one host the source names, never to the
 * other members a server tells of: the operator's list of allowed hosts
 * holds for every address AnyGridDB reaches.
 */
import { AppError, ceilingOf } from "@anygriddb/core";
import {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  MongoClient,
  MongoServerError,
  ObjectId,
  Timestamp,
} from "mongodb";
import { inScope } from "../table-scope.js";
import type {
  SourceCheck,
  SourceConnection,
  SourceListing,
  SourceTable,
  TableScope,
} from "../types.js";
import { connectionError } from "./errors.js";
import type {
  ConnectOptions,
  CopyConnector,
  CopyRequest,
  CopyRow,
  CopyValue,
} from "./types.js";
import {
  contentId,
  FieldSample,
  isCopyableName,
  rowId,
  type ValueKind,
} from "./values.js";

/** Documents read to tell a collection's fields: its newest ones. */
const SAMPLE = 200;
/** Collections listed, and fields kept in one: past these, a page is unusable. */
const MAX_COLLECTIONS = ceilingOf("copy.collections_listed");
const MAX_FIELDS = ceilingOf("copy.fields_read");
/** Collections sampled at once. */
const SAMPLING = 4;
const CONNECT_MS = 10_000;

/**
 * Roles that administer a deployment or its accounts. The account
 * AnyGridDB reads with needs `read` on its database and nothing more.
 */
const ADMIN_ROLES = new Set([
  "root",
  "__system",
  "dbOwner",
  "userAdmin",
  "userAdminAnyDatabase",
  "dbAdminAnyDatabase",
  "readWriteAnyDatabase",
  "clusterAdmin",
  "clusterManager",
  "hostManager",
  "restore",
]);

async function connect(
  source: SourceConnection,
  options: ConnectOptions,
): Promise<MongoClient> {
  const host = source.host.includes(":") ? `[${source.host}]` : source.host;
  const client = new MongoClient(`mongodb://${host}:${String(source.port)}/`, {
    auth: { username: source.username, password: source.password },
    // The account is one of the database it reads.
    authSource: source.database,
    appName: "AnyGridDB",
    // This host and no other: a server's list of members is not followed.
    directConnection: true,
    tls: !options.allowPlaintext,
    ...(options.allowPlaintext || !source.tlsCa ? {} : { ca: source.tlsCa }),
    serverSelectionTimeoutMS: CONNECT_MS,
    connectTimeoutMS: CONNECT_MS,
    socketTimeoutMS: source.queryTimeoutMs,
    maxPoolSize: 2,
    retryReads: false,
    // Numbers as the server typed them: an int is told from a double.
    promoteValues: false,
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw mongoError(error);
  }
}

async function withClient<T>(
  source: SourceConnection,
  options: ConnectOptions,
  body: (client: MongoClient) => Promise<T>,
): Promise<T> {
  const client = await connect(source, options);
  try {
    return await body(client);
  } catch (error) {
    throw mongoError(error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * What went wrong, as an administrator can fix it; never the raw text.
 * The driver's error stays as the cause, for the server's log.
 */
function mongoError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const cause = { cause: error };
  if (error instanceof MongoServerError) {
    // AuthenticationFailed, Unauthorized, MaxTimeMSExpired.
    if (error.code === 18 || error.code === 13) {
      return new AppError("source_auth_failed", cause);
    }
    if (error.code === 50) return new AppError("source_timeout", cause);
    return new AppError("source_query_failed", cause);
  }
  const known = connectionError(error);
  if (known) return known;
  const name = error instanceof Error ? error.name : "";
  if (name === "MongoNetworkTimeoutError") {
    return new AppError("source_timeout", cause);
  }
  return new AppError("source_unreachable", cause);
}

type Described = {
  kind: ValueKind;
  /** The type as MongoDB names it. */
  native: string;
  value: CopyValue;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** A value inside a document or a list, as JSON writes it. */
function plain(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Int32 || value instanceof Double)
    return plain(value.value);
  if (value instanceof Long) {
    const whole = value.toBigInt();
    const safe = BigInt(Number.MAX_SAFE_INTEGER);
    return whole >= -safe && whole <= safe ? Number(whole) : whole.toString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Array.isArray(value)) return value.map(plain);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, plain(item)]),
    );
  }
  return describe(value)?.value ?? null;
}

/** A top-level value: its kind, its MongoDB type, and what the copy keeps. */
function describe(value: unknown): Described | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return { kind: "text", native: "string", value };
  }
  if (typeof value === "boolean") {
    return { kind: "boolean", native: "bool", value };
  }
  if (value instanceof Int32) {
    return { kind: "integer", native: "int", value: value.value };
  }
  if (value instanceof Long) {
    return { kind: "integer", native: "bigint", value: value.toString() };
  }
  if (value instanceof Double || typeof value === "number") {
    const number = typeof value === "number" ? value : value.value;
    // NaN and the infinities fit no number field: told as text.
    return Number.isFinite(number)
      ? { kind: "number", native: "double", value: number }
      : { kind: "text", native: "double", value: String(number) };
  }
  if (typeof value === "bigint") {
    return { kind: "integer", native: "bigint", value: value.toString() };
  }
  if (value instanceof Decimal128) {
    const text = value.toString();
    return /^-?\d/.test(text)
      ? { kind: "number", native: "decimal", value: text }
      : { kind: "text", native: "decimal", value: text };
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : { kind: "datetime", native: "date", value: value.toISOString() };
  }
  if (value instanceof ObjectId) {
    return { kind: "text", native: "objectId", value: value.toHexString() };
  }
  if (value instanceof Binary) {
    return value.sub_type === Binary.SUBTYPE_UUID
      ? { kind: "text", native: "uuid", value: value.toUUID().toString() }
      : { kind: "text", native: "binData", value: value.toString("base64") };
  }
  if (value instanceof Timestamp) {
    return {
      kind: "text",
      native: "timestamp",
      value: `${String(value.t)}:${String(value.i)}`,
    };
  }
  if (value instanceof BSONRegExp) {
    return {
      kind: "text",
      native: "regex",
      value: `/${value.pattern}/${value.options}`,
    };
  }
  if (value instanceof BSONSymbol) {
    return { kind: "text", native: "symbol", value: value.value };
  }
  if (value instanceof Code) {
    return { kind: "text", native: "javascript", value: value.code };
  }
  if (value instanceof MinKey || value instanceof MaxKey) {
    return {
      kind: "text",
      native: value instanceof MinKey ? "minKey" : "maxKey",
      value: value instanceof MinKey ? "MinKey" : "MaxKey",
    };
  }
  if (value instanceof DBRef) {
    return {
      kind: "document",
      native: "object",
      value: JSON.stringify(plain(value.toJSON())),
    };
  }
  if (Array.isArray(value)) {
    return {
      kind: "document",
      native: "array",
      value: JSON.stringify(plain(value)),
    };
  }
  if (isPlainObject(value)) {
    return {
      kind: "document",
      native: "object",
      value: JSON.stringify(plain(value)),
    };
  }
  return null;
}

/** A document's `_id` as the text that names its row. */
function idOf(value: unknown): string | number | boolean {
  const described = describe(value);
  if (!described || described.value === null) return "";
  return described.value;
}

async function collectionTable(
  client: MongoClient,
  source: SourceConnection,
  entry: { name: string; type?: string },
): Promise<SourceTable> {
  const collection = client.db(source.database).collection(entry.name);
  // A view or a time series promises no `_id` of its own to each document.
  const keyed = entry.type === undefined || entry.type === "collection";
  const documents = await collection
    .find(
      {},
      {
        ...(keyed ? { sort: { _id: -1 } } : {}),
        limit: SAMPLE,
        maxTimeMS: source.queryTimeoutMs,
      },
    )
    .toArray();
  const samples = new Map<string, FieldSample>();
  for (const document of documents) {
    for (const [name, value] of Object.entries(document)) {
      if (!isCopyableName(name)) continue;
      let sample = samples.get(name);
      if (!sample) {
        if (samples.size >= MAX_FIELDS) continue;
        sample = new FieldSample();
        samples.set(name, sample);
      }
      const described = describe(value);
      if (described) {
        sample.add(
          described.kind,
          described.native,
          typeof described.value === "string" ? described.value : undefined,
        );
      }
    }
  }
  if (keyed && !samples.has("_id")) samples.set("_id", new FieldSample());
  const names = [...samples.keys()].sort(
    (left, right) => Number(right === "_id") - Number(left === "_id"),
  );
  const estimatedRows = keyed
    ? await collection.estimatedDocumentCount().catch(() => null)
    : null;
  return {
    schema: source.database,
    name: entry.name,
    kind: keyed ? "table" : "view",
    comment: null,
    estimatedRows,
    primaryKey: keyed ? ["_id"] : [],
    privileges: { insert: false, update: false, delete: false },
    columns: names.map((name) => {
      const { type, field } = samples.get(name)?.describe() ?? {
        type: "null",
        field: { fieldType: "text" as const, readOnly: false },
      };
      return {
        name,
        // An empty collection tells nothing of its `_id`: MongoDB's own.
        type: name === "_id" && type === "null" ? "objectId" : type,
        nullable: name !== "_id",
        comment: null,
        canUpdate: false,
        canInsert: false,
        field,
      };
    }),
    foreignKeys: [],
  };
}

/** The collections the account may read, with their fields. */
async function tables(
  source: SourceConnection,
  options: ConnectOptions,
  scope?: TableScope,
): Promise<SourceListing> {
  return withClient(source, options, async (client) => {
    const listed = await client
      .db(source.database)
      .listCollections({}, { nameOnly: true, authorizedCollections: true })
      .toArray();
    const entries = listed
      .filter((entry) => !entry.name.startsWith("system."))
      .filter(
        (entry) => entry.name.length <= 128 && !/\p{Cc}/u.test(entry.name),
      )
      .filter((entry) =>
        inScope({ schema: source.database, name: entry.name }, scope),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    const kept = entries.slice(0, MAX_COLLECTIONS);
    const found: SourceTable[] = [];
    for (let at = 0; at < kept.length; at += SAMPLING) {
      found.push(
        ...(await Promise.all(
          kept
            .slice(at, at + SAMPLING)
            .map((entry) => collectionTable(client, source, entry)),
        )),
      );
    }
    return { tables: found, truncated: entries.length > kept.length };
  });
}

async function check(
  source: SourceConnection,
  options: ConnectOptions,
): Promise<SourceCheck> {
  return withClient(source, options, async (client) => {
    const db = client.db(source.database);
    const info = await db.command({ buildInfo: 1 });
    const status = await db.command({ connectionStatus: 1 });
    const auth: unknown = status.authInfo;
    const roles = isPlainObject(auth) ? auth.authenticatedUserRoles : null;
    const administers =
      Array.isArray(roles) &&
      roles.some(
        (item: unknown) =>
          isPlainObject(item) &&
          typeof item.role === "string" &&
          ADMIN_ROLES.has(item.role),
      );
    if (administers) throw new AppError("source_admin_account");
    const version = typeof info.version === "string" ? info.version : "";
    const ferret: unknown = isPlainObject(info.ferretdb)
      ? info.ferretdb.version
      : null;
    return {
      serverVersion:
        typeof ferret === "string"
          ? `FerretDB ${ferret.replace(/^v/, "")} (MongoDB ${version})`
          : `MongoDB ${version}`,
    };
  });
}

async function* rows(
  source: SourceConnection,
  options: ConnectOptions,
  request: CopyRequest,
): AsyncGenerator<CopyRow[], void, void> {
  if (request.schema !== source.database) {
    throw new AppError("source_schema_changed");
  }
  const client = await connect(source, options);
  try {
    const keyed = request.key.length > 0;
    // A name with a dot or a dollar is a path to MongoDB, not a field:
    // such a collection is read whole.
    const paths = request.fields.some(
      (name) => name.includes(".") || name.startsWith("$"),
    );
    const found = client
      .db(source.database)
      .collection(request.name)
      .find(
        {},
        {
          ...(keyed ? { sort: { _id: 1 } } : {}),
          batchSize: request.pageSize,
          ...(paths
            ? {}
            : {
                projection: Object.fromEntries(
                  ["_id", ...request.fields].map((name) => [name, 1]),
                ),
              }),
        },
      );
    let page: CopyRow[] = [];
    for await (const document of found) {
      const values: Record<string, CopyValue> = {};
      for (const name of request.fields) {
        values[name] = describe(document[name])?.value ?? null;
      }
      page.push({
        id: keyed ? rowId([idOf(document._id)]) : contentId(values),
        values,
      });
      if (page.length >= request.pageSize) {
        yield page;
        page = [];
      }
    }
    if (page.length > 0) yield page;
  } catch (error) {
    throw mongoError(error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export const mongodb: CopyConnector = { check, tables, rows };
