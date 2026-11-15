/**
 * Neo4j (ADR 0088). The source's database is a Neo4j database, and each
 * label is a table: one row per node, named by its element id. A property
 * is a column. Relationships are not links.
 *
 * Nothing is written. An account that can administer users is refused.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@anygriddb/core";
import neo4j, { type Driver } from "neo4j-driver";
import type { SourceConnection, SourceTable } from "../types.js";
import { connectionError } from "./errors.js";
import { remember, tableFromSamples } from "./shape.js";
import type {
  ConnectOptions,
  CopyConnector,
  CopyRow,
  CopyValue,
} from "./types.js";
import {
  FieldSample,
  isCopyableName,
  rowId,
  type ValueKind,
} from "./values.js";

const SAMPLE = 200;

function labelOf(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new AppError("source_schema_changed");
  }
  return `\`${name}\``;
}

function neoError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const known = connectionError(error);
  if (known) return known;
  const message = error instanceof Error ? error.message : "";
  if (/unauthorized|authentication/i.test(message)) {
    return new AppError("source_auth_failed", { cause: error });
  }
  if (/timeout/i.test(message))
    return new AppError("source_timeout", { cause: error });
  return new AppError("source_unreachable", { cause: error });
}

async function withDriver<T>(
  source: SourceConnection,
  options: ConnectOptions,
  body: (driver: Driver) => Promise<T>,
): Promise<T> {
  const directory =
    source.tlsCa && !options.allowPlaintext
      ? mkdtempSync(join(tmpdir(), "ag-neo4j-"))
      : null;
  const certificate = directory ? join(directory, "ca.pem") : null;
  if (directory && certificate && source.tlsCa)
    writeFileSync(certificate, source.tlsCa);
  // bolt:// plus the encryption here. bolt+s would ignore a certificate
  // authority we supply, and the driver refuses to be told twice.
  const driver = neo4j.driver(
    `bolt://${source.host}:${String(source.port)}`,
    neo4j.auth.basic(source.username, source.password),
    {
      encrypted: options.allowPlaintext ? "ENCRYPTION_OFF" : "ENCRYPTION_ON",
      ...(options.allowPlaintext
        ? {}
        : {
            trust: certificate
              ? "TRUST_CUSTOM_CA_SIGNED_CERTIFICATES"
              : "TRUST_SYSTEM_CA_SIGNED_CERTIFICATES",
            ...(certificate ? { trustedCertificates: [certificate] } : {}),
          }),
      connectionTimeout: 10_000,
      disableLosslessIntegers: false,
      userAgent: "AnyGridDB",
    },
  );
  try {
    return await body(driver);
  } catch (error) {
    throw neoError(error);
  } finally {
    await driver.close().catch(() => undefined);
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

function kindOf(
  value: unknown,
): { kind: ValueKind; native: string; text?: string } | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return { kind: "boolean", native: "boolean" };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { kind: "integer", native: "integer" }
      : { kind: "number", native: "float" };
  }
  if (neo4j.isInt(value)) return { kind: "integer", native: "integer" };
  if (typeof value === "string")
    return { kind: "text", native: "string", text: value };
  if (value instanceof Date) return { kind: "datetime", native: "datetime" };
  return { kind: "document", native: "list" };
}

function kept(value: unknown): CopyValue {
  if (neo4j.isInt(value)) {
    const integer = value;
    return integer.inSafeRange() ? integer.toNumber() : integer.toString();
  }
  const told = kindOf(value);
  if (!told) return null;
  if (told.kind === "document") return JSON.stringify(value);
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return null;
}

export const neo4jStore: CopyConnector = {
  async check(source, options) {
    return withDriver(source, options, async (driver) => {
      const server = await driver.getServerInfo({ database: source.database });
      const session = driver.session({
        database: source.database,
        defaultAccessMode: "READ",
      });
      try {
        const roles = await session.run("SHOW CURRENT USER").catch(() => null);
        const listed: unknown = roles?.records[0]?.get("roles");
        const administers =
          source.username.toLowerCase() === "neo4j" ||
          (Array.isArray(listed) &&
            listed.some(
              (role) =>
                typeof role === "string" &&
                (role === "admin" || role === "architect"),
            ));
        if (administers) throw new AppError("source_admin_account");
      } finally {
        await session.close();
      }
      const agent = typeof server.agent === "string" ? server.agent : "";
      const version = agent.replace("/", " ").trim();
      return {
        serverVersion: version.startsWith("Neo4j")
          ? version
          : `Neo4j ${version}`.trim(),
      };
    });
  },

  async tables(source, options) {
    return withDriver(source, options, async (driver) => {
      const session = driver.session({
        database: source.database,
        defaultAccessMode: "READ",
      });
      try {
        const labels = await session.run(
          "CALL db.labels() YIELD label RETURN label",
        );
        const tables: SourceTable[] = [];
        for (const record of labels.records) {
          const label = String(record.get("label"));
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) continue;
          const nodes = await session.run(
            `MATCH (n:${labelOf(label)}) RETURN n LIMIT $limit`,
            { limit: neo4j.int(SAMPLE) },
          );
          const samples = new Map<string, FieldSample>();
          remember(samples, "_id", "text", "elementId");
          for (const node of nodes.records) {
            const nodeValue: unknown = node.get("n");
            const properties =
              nodeValue &&
              typeof nodeValue === "object" &&
              "properties" in nodeValue &&
              nodeValue.properties &&
              typeof nodeValue.properties === "object"
                ? (nodeValue.properties as Record<string, unknown>)
                : {};
            for (const [name, value] of Object.entries(properties)) {
              if (!isCopyableName(name)) continue;
              const told = kindOf(value);
              if (told)
                remember(samples, name, told.kind, told.native, told.text);
            }
          }
          tables.push(
            tableFromSamples({
              schema: source.database,
              name: label,
              key: ["_id"],
              samples,
              estimatedRows: null,
            }),
          );
        }
        return tables;
      } finally {
        await session.close();
      }
    });
  },

  async *rows(source, options, request) {
    if (request.schema !== source.database)
      throw new AppError("source_schema_changed");
    const directory =
      source.tlsCa && !options.allowPlaintext
        ? mkdtempSync(join(tmpdir(), "ag-neo4j-"))
        : null;
    const certificate = directory ? join(directory, "ca.pem") : null;
    if (directory && certificate && source.tlsCa)
      writeFileSync(certificate, source.tlsCa);
    const live = neo4j.driver(
      `bolt://${source.host}:${String(source.port)}`,
      neo4j.auth.basic(source.username, source.password),
      {
        encrypted: options.allowPlaintext ? "ENCRYPTION_OFF" : "ENCRYPTION_ON",
        ...(options.allowPlaintext
          ? {}
          : {
              trust: certificate
                ? "TRUST_CUSTOM_CA_SIGNED_CERTIFICATES"
                : "TRUST_SYSTEM_CA_SIGNED_CERTIFICATES",
              ...(certificate ? { trustedCertificates: [certificate] } : {}),
            }),
        connectionTimeout: 10_000,
      },
    );
    try {
      const session = live.session({
        database: source.database,
        defaultAccessMode: "READ",
      });
      try {
        // One pass. Asking again, ordered, would sort the label on every page.
        const found = session.run(
          `MATCH (n:${labelOf(request.name)})
           RETURN elementId(n) AS id, properties(n) AS props`,
        );
        let page: CopyRow[] = [];
        for await (const record of found) {
          const id = String(record.get("id"));
          const props = record.get("props") as Record<string, unknown>;
          const values: Record<string, CopyValue> = { _id: id };
          for (const name of request.fields) {
            if (name === "_id") continue;
            values[name] = kept(props[name]);
          }
          page.push({ id: rowId([id]), values });
          if (page.length >= request.pageSize) {
            yield page;
            page = [];
          }
        }
        if (page.length > 0) yield page;
      } finally {
        await session.close();
      }
    } catch (error) {
      throw neoError(error);
    } finally {
      await live.close().catch(() => undefined);
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  },
};
