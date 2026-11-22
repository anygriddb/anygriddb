/**
 * A search cluster read through the OpenSearch REST API (ADR 0088): each
 * index is a table, each document a row named by its `_id`, each
 * top-level field of the mapping a column. A field that holds an object,
 * or several values, is kept whole, as JSON.
 *
 * The mapping says each field's type; a few documents say which fields
 * hold several values, which no mapping tells.
 */
import { AppError, type MappedField } from "@anygriddb/core";
import { inScope } from "../table-scope.js";
import type {
  SourceCheck,
  SourceConnection,
  SourceListing,
  SourceTable,
  TableScope,
} from "../types.js";
import { openHttp, type HttpAnswer, type HttpStore } from "./http.js";
import type {
  ConnectOptions,
  CopyConnector,
  CopyRequest,
  CopyRow,
  CopyValue,
} from "./types.js";
import { isCopyableName, rowId } from "./values.js";

/** Documents read to tell which fields hold several values, or long texts. */
const SAMPLE = 200;
const MAX_INDICES = 1_000;
const MAX_FIELDS = 300;
/** A scroll lives this long between two pages. */
const SCROLL = "5m";
/** Longer than this, or on several lines, a text is a long one. */
const SHORT_TEXT = 255;

/** The roles that administer a cluster and its accounts. */
const ADMIN_ROLES = new Set(["all_access", "security_manager"]);

const WHOLE = new Set(["long", "integer", "short", "byte", "unsigned_long"]);
const DECIMAL = new Set(["double", "float", "half_float", "scaled_float"]);
const TEXTS = new Set([
  "keyword",
  "text",
  "wildcard",
  "constant_keyword",
  "match_only_text",
  "ip",
  "version",
]);
const DATES = new Set(["date", "date_nanos"]);

type Kind = "text" | "number" | "boolean" | "datetime" | "document";

/** What a field of the mapping is to AnyGridDB. */
function kindOf(type: string): Kind {
  if (WHOLE.has(type) || DECIMAL.has(type)) return "number";
  if (type === "boolean") return "boolean";
  if (DATES.has(type)) return "datetime";
  if (TEXTS.has(type)) return "text";
  // An object, a nested list, a point, a range, a vector: kept whole.
  return "document";
}

/** A name the shared number format already understands. */
function columnType(type: string, kind: Kind): string {
  if (kind !== "number") return type;
  return WHOLE.has(type) ? "integer" : "double";
}

const FIELD: Record<Kind, MappedField["fieldType"]> = {
  text: "text",
  number: "number",
  boolean: "boolean",
  datetime: "datetime",
  document: "json",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What went wrong, from the status of an answer that is not a success. */
function refusal(answer: HttpAnswer): AppError {
  if (answer.status === 401) return new AppError("source_auth_failed");
  if (answer.status === 404) return new AppError("source_schema_changed");
  if (answer.status === 408 || answer.status === 504) {
    return new AppError("source_timeout");
  }
  return new AppError("source_query_failed", String(answer.status));
}

async function ask(
  store: HttpStore,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const answer = await store.request(method, path, body);
  if (answer.status < 200 || answer.status >= 300 || !isRecord(answer.body)) {
    throw refusal(answer);
  }
  return answer.body;
}

/** The indices a source reads: its pattern, `*` when it names none. */
export function patternPath(
  source: Pick<SourceConnection, "database">,
): string {
  const parts = source.database
    .split(",")
    .map((part) => encodeURIComponent(part.trim()))
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(",") : "*";
}

async function check(
  source: SourceConnection,
  options: ConnectOptions,
): Promise<SourceCheck> {
  const store = openHttp(source, options);
  try {
    const root = await ask(store, "GET", "/");
    const version = isRecord(root.version) ? root.version : {};
    const number = typeof version.number === "string" ? version.number : "";
    // Only a cluster that says it is OpenSearch. Another search server
    // is a different product, and this connector does not speak for it.
    if (version.distribution !== "opensearch" || number === "") {
      throw new AppError("source_engine_mismatch");
    }
    // The security plugin tells the account's roles; a cluster without it
    // has no account to tell of.
    const who = await store.request("GET", "/_plugins/_security/authinfo");
    const roles =
      who.status === 200 && isRecord(who.body) ? who.body.roles : null;
    if (
      Array.isArray(roles) &&
      roles.some((role) => typeof role === "string" && ADMIN_ROLES.has(role))
    ) {
      throw new AppError("source_admin_account");
    }
    return { serverVersion: `OpenSearch ${number}` };
  } finally {
    store.close();
  }
}

type Mapped = { name: string; type: string; kind: Kind };

/** The top-level fields of an index's mapping a copy can keep. */
function mappedFields(mapping: unknown): Mapped[] {
  const properties =
    isRecord(mapping) && isRecord(mapping.mappings)
      ? mapping.mappings.properties
      : null;
  if (!isRecord(properties)) return [];
  const fields: Mapped[] = [];
  for (const [name, definition] of Object.entries(properties)) {
    if (!isCopyableName(name) || name === "_id") continue;
    if (fields.length >= MAX_FIELDS) break;
    // A field with properties and no type is an object.
    const type =
      isRecord(definition) && typeof definition.type === "string"
        ? definition.type
        : "object";
    // An alias only names another field.
    if (type === "alias") continue;
    fields.push({ name, type, kind: kindOf(type) });
  }
  return fields;
}

async function indexTable(
  store: HttpStore,
  index: string,
  mapping: unknown,
): Promise<SourceTable> {
  const fields = mappedFields(mapping);
  const path = `/${encodeURIComponent(index)}`;
  const sampled = await ask(store, "POST", `${path}/_search`, {
    size: SAMPLE,
    sort: ["_doc"],
    track_total_hits: true,
  });
  const hits = isRecord(sampled.hits) ? sampled.hits : {};
  const total = isRecord(hits.total) ? hits.total.value : null;
  const several = new Set<string>();
  const long = new Set<string>();
  for (const hit of Array.isArray(hits.hits) ? hits.hits : []) {
    const document: unknown = isRecord(hit) ? hit._source : null;
    if (!isRecord(document)) continue;
    for (const field of fields) {
      const value = document[field.name];
      if (Array.isArray(value)) several.add(field.name);
      if (
        typeof value === "string" &&
        (value.length > SHORT_TEXT || value.includes("\n"))
      ) {
        long.add(field.name);
      }
    }
  }
  return {
    schema: INDICES,
    name: index,
    kind: "table",
    comment: null,
    estimatedRows: typeof total === "number" ? total : null,
    primaryKey: ["_id"],
    privileges: { insert: false, update: false, delete: false },
    columns: [
      {
        name: "_id",
        type: "keyword",
        nullable: false,
        comment: null,
        canUpdate: false,
        canInsert: false,
        field: { fieldType: "text", readOnly: false },
      },
      ...fields.map((field) => {
        const kind = several.has(field.name) ? "document" : field.kind;
        return {
          name: field.name,
          type: several.has(field.name)
            ? `${field.type}[]`
            : columnType(field.type, kind),
          nullable: true,
          comment: null,
          canUpdate: false,
          canInsert: false,
          field: {
            fieldType:
              kind === "text" && long.has(field.name)
                ? ("long_text" as const)
                : FIELD[kind],
            readOnly: false,
          },
        };
      }),
    ],
    foreignKeys: [],
  };
}

/** The one place a cluster keeps its indices: it has no schema to name. */
const INDICES = "indices";

/** The open indices the account may read, hidden ones left out. */
async function tables(
  source: SourceConnection,
  options: ConnectOptions,
  scope?: TableScope,
): Promise<SourceListing> {
  const store = openHttp(source, options);
  try {
    const mappings = await ask(
      store,
      "GET",
      `/${patternPath(source)}/_mapping?expand_wildcards=open&ignore_unavailable=true`,
    );
    const names = Object.keys(mappings)
      .filter((name) => !name.startsWith(".") && name.length <= 128)
      .filter((name) => inScope({ schema: INDICES, name }, scope))
      .sort((left, right) => left.localeCompare(right));
    const found: SourceTable[] = [];
    for (const name of names.slice(0, MAX_INDICES)) {
      found.push(await indexTable(store, name, mappings[name]));
    }
    return { tables: found, truncated: names.length > MAX_INDICES };
  } finally {
    store.close();
  }
}

/** A value of a document, as the copy's column of that kind takes it. */
function cell(kind: Kind, value: unknown): CopyValue {
  if (value === null || value === undefined) return null;
  // Several values, or an object: kept whole.
  if (typeof value === "object") return JSON.stringify(value);
  if (kind === "boolean" && typeof value === "string") {
    // The store takes these two texts for a boolean.
    return value === "true" ? true : value === "false" ? false : value;
  }
  if (kind === "document") return JSON.stringify(value);
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  return null;
}

async function* rows(
  source: SourceConnection,
  options: ConnectOptions,
  request: CopyRequest,
): AsyncGenerator<CopyRow[], void, void> {
  const store = openHttp(source, options);
  const path = `/${encodeURIComponent(request.name)}`;
  let scroll: unknown;
  try {
    const mapping = await ask(store, "GET", `${path}/_mapping`);
    const kinds = new Map(
      mappedFields(mapping[request.name]).map((field) => [
        field.name,
        field.kind,
      ]),
    );
    const wanted = request.fields.filter((name) => name !== "_id");
    const dates = wanted.filter((name) => kinds.get(name) === "datetime");
    // An empty `fields` list is refused. Dates are asked as one UTC text;
    // every other value is read from the document itself.
    const body: Record<string, unknown> = {
      size: request.pageSize,
      // The index's own order: the cheapest way through every document.
      // A scroll refuses a request that turns the total off.
      sort: ["_doc"],
      _source: { includes: wanted },
    };
    if (dates.length > 0) {
      body.fields = dates.map((field) => ({
        field,
        format: "strict_date_time",
      }));
    }
    let page = await ask(
      store,
      "POST",
      `${path}/_search?scroll=${SCROLL}`,
      body,
    );
    for (;;) {
      scroll = page._scroll_id;
      const hits =
        isRecord(page.hits) && Array.isArray(page.hits.hits)
          ? page.hits.hits
          : [];
      if (hits.length === 0) return;
      yield hits.filter(isRecord).map((hit) => {
        const document = isRecord(hit._source) ? hit._source : {};
        const formatted = isRecord(hit.fields) ? hit.fields : {};
        const id = typeof hit._id === "string" ? hit._id : "";
        const values: Record<string, CopyValue> = { _id: id };
        for (const name of wanted) {
          const kind = kinds.get(name) ?? "document";
          const dated: unknown = formatted[name];
          values[name] =
            kind === "datetime" && Array.isArray(dated)
              ? cell(kind, dated.length === 1 ? dated[0] : dated)
              : cell(kind, document[name]);
        }
        return { id: rowId([id]), values };
      });
      if (typeof scroll !== "string") return;
      page = await ask(store, "POST", "/_search/scroll", {
        scroll: SCROLL,
        scroll_id: scroll,
      });
    }
  } finally {
    if (typeof scroll === "string") {
      try {
        await store.request("DELETE", "/_search/scroll", { scroll_id: scroll });
      } catch {
        // The cluster drops a scroll when its time ends.
      }
    }
    store.close();
  }
}

export const opensearch: CopyConnector = { check, tables, rows };
