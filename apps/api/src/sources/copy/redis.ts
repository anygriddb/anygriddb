/**
 * A store that speaks the Redis wire protocol (ADR 0088), tested against
 * Valkey. A table is the keys that start with the prefix named as the
 * source's database. A hash is a row of fields; a string that is a JSON
 * object is a row of its keys; anything else is one `value` field. The
 * key itself is the column `_key`.
 *
 * Nothing is written. A prefix that would match every key is refused.
 */
import { AppError } from "@anygriddb/core";
import Redis from "ioredis";
import type { SourceConnection, SourceTable } from "../types.js";
import { connectionError } from "./errors.js";
import { remember, tableFromSamples } from "./shape.js";
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

const CONNECT_MS = 10_000;
const SAMPLE = 200;

/** Commands that administer the server, not one key prefix. */
const ADMIN = [
  "+@all",
  "+@admin",
  "+@dangerous",
  "+acl",
  "+flushall",
  "+flushdb",
  "allcommands",
];

/**
 * A prefix a copy may read: something, never every key, never a pattern
 * of the server's own.
 */
export function redisPrefix(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    !/[\s*?[\]]/u.test(value) &&
    !/\p{Cc}/u.test(value)
  );
}

function patternOf(prefix: string): string {
  return `${prefix}*`;
}

async function open(
  source: SourceConnection,
  options: ConnectOptions,
): Promise<Redis> {
  if (!redisPrefix(source.database)) {
    throw new AppError("invalid_arguments");
  }
  const redis = new Redis({
    host: source.host,
    port: source.port,
    username: source.username,
    password: source.password,
    db: 0,
    tls: options.allowPlaintext
      ? undefined
      : { ca: source.tlsCa ?? undefined, servername: source.host },
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    // A host that does not answer fails the call. It is not retried, and
    // commands are not kept for a later connection.
    retryStrategy: () => null,
    reconnectOnError: () => false,
    connectTimeout: CONNECT_MS,
    commandTimeout: source.queryTimeoutMs,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    return redis;
  } catch (error) {
    redis.disconnect();
    throw redisError(error);
  }
}

function redisError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const known = connectionError(error);
  if (known) return known;
  const message = error instanceof Error ? error.message : "";
  if (/NOAUTH|WRONGPASS|invalid username/i.test(message)) {
    return new AppError("source_auth_failed", { cause: error });
  }
  if (/timeout/i.test(message))
    return new AppError("source_timeout", { cause: error });
  return new AppError("source_unreachable", { cause: error });
}

/** True when the account holds a command that can change the whole server. */
function administers(reply: unknown): boolean {
  const text = JSON.stringify(reply);
  return ADMIN.some((flag) => text.includes(flag));
}

function kindOf(value: string): {
  kind: ValueKind;
  native: string;
  text?: string;
} {
  if (value === "true" || value === "false") {
    return { kind: "boolean", native: "bool", text: value };
  }
  if (/^-?\d+$/.test(value)) {
    // Past 2^53 a JavaScript number is no longer that integer. The copy
    // keeps the digits, and a bigint column accepts them.
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber)) {
      return { kind: "integer", native: "bigint", text: value };
    }
    return { kind: "integer", native: "int" };
  }
  if (/^-?\d+\.\d+$/.test(value)) return { kind: "number", native: "double" };
  if ((value.startsWith("{") || value.startsWith("[")) && value.length > 1) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") {
        return { kind: "document", native: "json", text: value };
      }
    } catch {
      // A string that only looks like JSON stays text.
    }
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return { kind: "datetime", native: "string", text: value };
  }
  return { kind: "text", native: "string", text: value };
}

/** One Redis string as a copy cell. A document stays its JSON text. */
export function redisCell(value: string): CopyValue {
  const told = kindOf(value);
  if (told.kind === "boolean") return value === "true";
  if (told.kind === "document") return value;
  if (told.kind === "integer" && told.text !== undefined) return told.text;
  if (told.kind === "integer" || told.kind === "number") return Number(value);
  return value;
}

function fieldsOf(raw: Record<string, string>): Record<string, CopyValue> {
  const values: Record<string, CopyValue> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isCopyableName(name)) continue;
    values[name] = redisCell(value);
  }
  return values;
}

function jsonText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return value.toString();
  }
  if (typeof value === "bigint") return value.toString();
  return JSON.stringify(value);
}

function stringRecord(text: string): Record<string, string> {
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.fromEntries(
          Object.entries(parsed).map(([name, value]) => [
            name,
            jsonText(value),
          ]),
        );
      }
    } catch {
      // A string that is not an object is one field.
    }
  }
  return { value: text };
}

function commandResult(reply: [Error | null, unknown] | undefined): unknown {
  if (!reply) return null;
  if (reply[0]) throw reply[0];
  return reply[1];
}

/** The fields of one page of keys, in two round trips rather than two per key. */
async function readKeys(
  redis: Redis,
  keys: readonly string[],
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (keys.length === 0) return out;
  const typed = await redis.pipeline(keys.map((key) => ["type", key])).exec();
  const hashes: string[] = [];
  const strings: string[] = [];
  keys.forEach((key, index) => {
    const type = commandResult(typed?.[index]);
    if (type === "hash") hashes.push(key);
    else if (type === "string") strings.push(key);
    else out.set(key, { value: typeof type === "string" ? type : "none" });
  });
  if (hashes.length > 0) {
    const got = await redis
      .pipeline(hashes.map((key) => ["hgetall", key]))
      .exec();
    hashes.forEach((key, index) => {
      const value = commandResult(got?.[index]);
      out.set(
        key,
        value !== null && typeof value === "object"
          ? (value as Record<string, string>)
          : {},
      );
    });
  }
  if (strings.length > 0) {
    const got = await redis.pipeline(strings.map((key) => ["get", key])).exec();
    strings.forEach((key, index) => {
      const text = commandResult(got?.[index]);
      out.set(key, stringRecord(typeof text === "string" ? text : ""));
    });
  }
  return out;
}

async function hashOf(
  redis: Redis,
  key: string,
): Promise<Record<string, string>> {
  const found = await readKeys(redis, [key]);
  return found.get(key) ?? { value: "none" };
}

async function sampleKeys(redis: Redis, prefix: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      patternOf(prefix),
      "COUNT",
      200,
    );
    cursor = next;
    found.push(...keys);
  } while (cursor !== "0" && found.length < SAMPLE);
  return found.slice(0, SAMPLE);
}

export const redis: CopyConnector = {
  async check(source, options) {
    const redis = await open(source, options);
    try {
      const info = await redis.info("server");
      const version = /redis_version:(\S+)/.exec(info)?.[1] ?? "";
      const user = await redis
        .call("ACL", "GETUSER", source.username)
        .catch(() => null);
      if (user && administers(user)) throw new AppError("source_admin_account");
      return { serverVersion: `Redis ${version}` };
    } catch (error) {
      throw redisError(error);
    } finally {
      redis.disconnect();
    }
  },

  async tables(source, options): Promise<SourceTable[]> {
    const redis = await open(source, options);
    try {
      const keys = await sampleKeys(redis, source.database);
      const samples = new Map<string, FieldSample>();
      remember(samples, "_key", "text", "key");
      for (const key of keys) {
        const fields = await hashOf(redis, key);
        for (const [name, value] of Object.entries(fields)) {
          if (!isCopyableName(name)) continue;
          const told = kindOf(value);
          remember(samples, name, told.kind, told.native, told.text);
        }
      }
      return [
        tableFromSamples({
          schema: source.database,
          name: source.database,
          key: ["_key"],
          samples,
          estimatedRows: null,
        }),
      ];
    } catch (error) {
      throw redisError(error);
    } finally {
      redis.disconnect();
    }
  },

  async *rows(source, options, request: CopyRequest) {
    if (
      request.schema !== source.database ||
      request.name !== source.database
    ) {
      throw new AppError("source_schema_changed");
    }
    const redis = await open(source, options);
    try {
      let cursor = "0";
      let page: CopyRow[] = [];
      const seen = new Set<string>();
      do {
        const [next, keys] = await redis.scan(
          cursor,
          "MATCH",
          patternOf(source.database),
          "COUNT",
          request.pageSize,
        );
        cursor = next;
        const fresh = keys.filter((key) => {
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const described = await readKeys(redis, fresh);
        for (const key of fresh) {
          const fields = fieldsOf(described.get(key) ?? {});
          const values: Record<string, CopyValue> = { _key: key };
          for (const name of request.fields) {
            if (name === "_key") continue;
            values[name] = fields[name] ?? null;
          }
          page.push({
            id: request.key.length > 0 ? rowId([key]) : contentId(values),
            values,
          });
          if (page.length >= request.pageSize) {
            yield page;
            page = [];
          }
        }
      } while (cursor !== "0");
      if (page.length > 0) yield page;
    } catch (error) {
      throw redisError(error);
    } finally {
      redis.disconnect();
    }
  },
};
