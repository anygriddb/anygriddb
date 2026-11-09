/**
 * Shared control-plane + source declaration helpers for sample suites.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "@anygriddb/db";
import { insertBase } from "../../data/schema-ops.js";
import { createTestDatabase } from "../../test-database.js";
import { exposeTables, setTableWrites } from "../expose.js";
import { setSourcePools, SourcePools } from "../pools.js";
import { createSource, sourceTables } from "../sources.js";
import type { SourceSettings } from "../types.js";
import { seedsRoot } from "./paths.js";
import type { SampleEndpoint, SampleEngine } from "./types.js";

/** Lab compose speaks TLS; Testcontainers samples keep plaintext. */
function labCa(): string | null {
  const fromEnv = process.env.ANYGRIDDB_LAB_TLS_CA?.trim();
  if (fromEnv && existsSync(fromEnv)) return readFileSync(fromEnv, "utf8");
  const candidate = join(seedsRoot(), "../certs/ca.crt");
  if (process.env.ANYGRIDDB_LAB_HOST && existsSync(candidate)) {
    return readFileSync(candidate, "utf8");
  }
  return null;
}

const labTls = labCa();

/** A value a sample suite cannot go on without: its absence fails the test. */
export function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`sample suite: no ${what}`);
  }
  return value;
}

export const sampleSettings: SourceSettings = {
  allows: () => true,
  allowedHosts: [],
  allowPlaintext: !labTls,
};

export type SampleControl = {
  db: Database;
  close: () => Promise<void>;
  key: Buffer;
  actorId: string;
  baseId: string;
  pools: SourcePools;
  deps: { db: Database; key: Buffer; settings: SourceSettings };
};

export type DeclaredSource = {
  engine: SampleEngine;
  sourceId: string;
  endpoint: SampleEndpoint;
};

export async function openSampleControl(
  prefix = "samples",
): Promise<SampleControl> {
  const control = await createTestDatabase(prefix);
  const key = randomBytes(32);
  const actorId = (
    await control.db
      .insertInto("users")
      .values({
        email: `samples-${randomBytes(4).toString("hex")}@example.com`,
        displayName: "Samples Admin",
        isAdmin: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  const pools = new SourcePools({
    db: control.db,
    key,
    settings: sampleSettings,
    log: () => undefined,
  });
  setSourcePools(pools);
  const base = await insertBase(control.db, actorId, { name: "Lab Samples" });
  return {
    db: control.db,
    close: control.close,
    key,
    actorId,
    baseId: base.id,
    pools,
    deps: { db: control.db, key, settings: sampleSettings },
  };
}

export async function closeSampleControl(
  control: SampleControl | undefined,
): Promise<void> {
  setSourcePools(undefined);
  // A failed beforeAll leaves no control: let its error be the one reported.
  if (!control) return;
  await control.pools.close();
  await control.close();
}

export async function declareSource(
  control: SampleControl,
  endpoint: SampleEndpoint,
  database: string,
  name: string,
): Promise<DeclaredSource> {
  const created = await createSource(control.deps, control.actorId, {
    name,
    engine: endpoint.engine,
    host: endpoint.host,
    port: endpoint.port,
    database,
    username: endpoint.username,
    password: endpoint.password,
    tlsCa: labTls,
    connectionLimit: 4,
    queryTimeoutMs: 60_000,
    timeZone: "UTC",
    sideSchema: endpoint.sideSchema,
  });
  if (!created.id) throw new Error("createSource returned no id");
  return {
    engine: endpoint.engine,
    sourceId: created.id,
    endpoint,
  };
}

export async function exposeChinook(
  control: SampleControl,
  declared: DeclaredSource,
): Promise<Record<string, string>> {
  const schema = declared.endpoint.chinookSchema;
  const tables =
    declared.engine === "postgres"
      ? [
          { schema, name: "artist" },
          { schema, name: "album" },
          { schema, name: "track" },
          { schema, name: "genre" },
          { schema, name: "customer" },
          { schema, name: "invoice" },
          { schema, name: "invoice_line" },
          { schema, name: "playlist" },
          { schema, name: "playlist_track" },
        ]
      : [
          { schema, name: "Artist" },
          { schema, name: "Album" },
          { schema, name: "Track" },
          { schema, name: "Genre" },
          { schema, name: "Customer" },
          { schema, name: "Invoice" },
          { schema, name: "InvoiceLine" },
          { schema, name: "Playlist" },
          { schema, name: "PlaylistTrack" },
        ];
  const { tableIds } = await exposeTables(control.deps, control.actorId, {
    sourceId: declared.sourceId,
    baseId: control.baseId,
    tables,
  });
  const names = tables.map((t) => t.name.toLowerCase());
  const map: Record<string, string> = {};
  for (const [index, name] of names.entries()) {
    const id = tableIds[index];
    if (id) map[name] = id;
  }
  return map;
}

export async function exposeNorthwind(
  control: SampleControl,
  declared: DeclaredSource,
): Promise<Record<string, string>> {
  const schema = declared.endpoint.northwindSchema;
  // harryho ports use different casings per engine; introspect and pick.
  const listed = await sourceTables(control.deps, declared.sourceId);
  const want = new Set(
    [
      "customer",
      "product",
      "salesorder",
      "orderdetail",
      "category",
      "supplier",
      "employee",
      "customers",
      "products",
      "orders",
      "order details",
      "categories",
      "suppliers",
      "employees",
    ].map((n) => n.toLowerCase()),
  );
  const tables = listed
    .filter((t) => t.schema === schema && want.has(t.name.toLowerCase()))
    .map((t) => ({ schema: t.schema, name: t.name }));
  if (tables.length === 0) {
    throw new Error(`No Northwind tables found in schema ${schema}`);
  }
  const { tableIds } = await exposeTables(control.deps, control.actorId, {
    sourceId: declared.sourceId,
    baseId: control.baseId,
    tables,
  });
  const map: Record<string, string> = {};
  for (const [index, table] of tables.entries()) {
    const id = tableIds[index];
    if (id) map[table.name.toLowerCase()] = id;
  }
  return map;
}

export async function enablePlaylistWrites(
  control: SampleControl,
  tableId: string,
): Promise<void> {
  await setTableWrites(control.deps, control.actorId, {
    tableId,
    update: true,
    insert: true,
    delete: true,
  });
}

export { sourceTables };
