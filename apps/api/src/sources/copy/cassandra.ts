/**
 * Cassandra (ADR 0088). A keyspace is the database, a table is a table,
 * and a row is read by paging the table from first to last, on the one
 * host the source names.
 *
 * Nothing is written. A superuser is refused when the server says so.
 */
import { lookup, resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "@anygriddb/core";
import { Client, policies, types } from "cassandra-driver";
import type { SourceConnection } from "../types.js";
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

function quote(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new AppError("source_schema_changed");
  }
  return `"${name}"`;
}

function cassandraError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const known = connectionError(error);
  if (known) return known;
  const message = error instanceof Error ? error.message : "";
  if (/authentication|unauthorized|bad credentials/i.test(message)) {
    return new AppError("source_auth_failed", { cause: error });
  }
  if (/timed out|timeout/i.test(message)) {
    return new AppError("source_timeout", { cause: error });
  }
  return new AppError("source_unreachable", { cause: error });
}

/**
 * The addresses the source's host resolves to, as the driver names a
 * node (`address:port`), by the two ways the driver itself resolves it.
 */
export async function hostAddresses(
  source: SourceConnection,
): Promise<string[]> {
  const found = new Set<string>();
  if (isIP(source.host)) found.add(source.host);
  const lists = await Promise.allSettled([
    lookup(source.host, { all: true }).then((all) =>
      all.map((item) => item.address),
    ),
    resolve4(source.host),
    resolve6(source.host),
  ]);
  for (const list of lists) {
    if (list.status === "fulfilled") {
      for (const address of list.value) found.add(address);
    }
  }
  if (found.size === 0) throw new AppError("source_unreachable");
  return [...found].map((address) => `${address}:${String(source.port)}`);
}

/**
 * A client of the one host the source names. The driver would otherwise
 * learn the cluster's other nodes from this one and connect to them; the
 * allow list keeps every query, and every connection, on this host, so
 * no data center needs naming either.
 */
async function open(
  source: SourceConnection,
  options: ConnectOptions,
  keyspace?: string,
): Promise<Client> {
  const client = new Client({
    contactPoints: [`${source.host}:${String(source.port)}`],
    policies: {
      loadBalancing: new policies.loadBalancing.AllowListPolicy(
        new policies.loadBalancing.RoundRobinPolicy(),
        await hostAddresses(source),
      ),
    },
    keyspace,
    credentials: { username: source.username, password: source.password },
    protocolOptions: { port: source.port },
    socketOptions: {
      connectTimeout: CONNECT_MS,
      readTimeout: source.queryTimeoutMs,
    },
    sslOptions: options.allowPlaintext
      ? undefined
      : {
          rejectUnauthorized: true,
          ca: source.tlsCa ? [source.tlsCa] : undefined,
          servername: source.host,
        },
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.shutdown().catch(() => undefined);
    throw cassandraError(error);
  }
}

function kindOf(
  value: unknown,
): { kind: ValueKind; native: string; text?: string } | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return { kind: "boolean", native: "boolean" };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { kind: "integer", native: "int" }
      : { kind: "number", native: "double" };
  }
  if (typeof value === "bigint") return { kind: "integer", native: "bigint" };
  if (value instanceof types.Long) {
    return { kind: "integer", native: "bigint" };
  }
  if (value instanceof types.Integer)
    return { kind: "integer", native: "varint" };
  if (value instanceof types.BigDecimal)
    return { kind: "number", native: "decimal" };
  if (value instanceof types.LocalDate) return { kind: "date", native: "date" };
  if (value instanceof types.LocalTime)
    return { kind: "text", native: "time", text: value.toString() };
  if (value instanceof types.TimeUuid || value instanceof types.Uuid) {
    return { kind: "text", native: "uuid", text: value.toString() };
  }
  if (value instanceof Date) {
    return { kind: "datetime", native: "timestamp", text: value.toISOString() };
  }
  if (typeof value === "string")
    return { kind: "text", native: "text", text: value };
  return { kind: "document", native: "json" };
}

function kept(value: unknown): CopyValue {
  const told = kindOf(value);
  if (!told) return null;
  if (told.kind === "boolean") return value === true;
  if (told.kind === "integer" || told.kind === "number") {
    if (typeof value === "bigint") {
      const asNumber = Number(value);
      return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
    }
    if (typeof value === "number") return value;
    if (value instanceof types.Long || value instanceof types.Integer)
      return value.toString();
    if (value instanceof types.BigDecimal) return value.toString();
  }
  if (told.kind === "datetime" && value instanceof Date)
    return value.toISOString();
  if (told.kind === "date" && value instanceof types.LocalDate)
    return value.toString();
  if (typeof value === "string") return value;
  if (told.text) return told.text;
  return JSON.stringify(value);
}

export const cassandra: CopyConnector = {
  async check(source, options) {
    const client = await open(source, options);
    try {
      const local = await client.execute(
        "SELECT release_version FROM system.local",
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const version = local.rows[0]?.get("release_version");
      const roles = await client
        .execute(
          "SELECT role, is_superuser FROM system_auth.roles WHERE role = ?",
          [source.username],
        )
        .catch(() => null);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const superuser = roles?.rows[0]?.get("is_superuser");
      if (superuser === true) throw new AppError("source_admin_account");
      return {
        serverVersion:
          `Cassandra ${typeof version === "string" ? version : ""}`.trim(),
      };
    } catch (error) {
      throw cassandraError(error);
    } finally {
      await client.shutdown().catch(() => undefined);
    }
  },

  async tables(source, options) {
    const client = await open(source, options, source.database);
    try {
      const listed = await client.execute(
        "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?",
        [source.database],
      );
      const keys = await client.execute(
        "SELECT table_name, column_name, kind, type FROM system_schema.columns WHERE keyspace_name = ?",
        [source.database],
      );
      const byTable = new Map<string, Map<string, FieldSample>>();
      const primary = new Map<string, string[]>();
      for (const row of keys.rows) {
        const table = String(row.get("table_name"));
        const column = String(row.get("column_name"));
        if (!isCopyableName(column)) continue;
        const samples = byTable.get(table) ?? new Map<string, FieldSample>();
        const type = String(row.get("type"));
        const kind: ValueKind = /int|counter/.test(type)
          ? "integer"
          : /float|double|decimal/.test(type)
            ? "number"
            : type === "boolean"
              ? "boolean"
              : type === "timestamp"
                ? "datetime"
                : type === "date"
                  ? "date"
                  : "text";
        remember(samples, column, kind, type);
        byTable.set(table, samples);
        if (row.get("kind") === "partition_key") {
          primary.set(table, [...(primary.get(table) ?? []), column]);
        }
      }
      return listed.rows.flatMap((row) => {
        const name = String(row.get("table_name"));
        const key = primary.get(name) ?? [];
        // A table with no partition key cannot be read from first to last.
        if (key.length === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          return [];
        }
        return [
          tableFromSamples({
            schema: source.database,
            name,
            key,
            samples: byTable.get(name) ?? new Map(),
            estimatedRows: null,
          }),
        ];
      });
    } catch (error) {
      throw cassandraError(error);
    } finally {
      await client.shutdown().catch(() => undefined);
    }
  },

  async *rows(source, options, request: CopyRequest) {
    if (request.schema !== source.database)
      throw new AppError("source_schema_changed");
    const client = await open(source, options, source.database);
    try {
      let page: string | undefined;
      do {
        const result = await client.execute(
          `SELECT * FROM ${quote(request.schema)}.${quote(request.name)}`,
          [],
          { prepare: false, fetchSize: request.pageSize, pageState: page },
        );
        const batch: CopyRow[] = result.rows.map((row) => {
          const values: Record<string, CopyValue> = {};
          for (const name of request.fields) values[name] = kept(row.get(name));
          const id = request.key.length
            ? rowId(request.key.map((name) => kept(row.get(name)) ?? ""))
            : contentId(values);
          return { id, values };
        });
        if (batch.length > 0) yield batch;
        page = result.pageState;
      } while (page);
    } catch (error) {
      throw cassandraError(error);
    } finally {
      await client.shutdown().catch(() => undefined);
    }
  },
};
