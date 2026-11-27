/**
 * A store that speaks the MongoDB wire protocol, read from a copy
 * (ADR 0088), against a real FerretDB over verified TLS: declared,
 * listed, exposed, copied, refreshed, and refused what a copy cannot do.
 */
import { giveInstanceRole } from "../../auth/instance-roles.test-helpers.js";
import { createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import { AppError, type EngineCatalog } from "@anygriddb/core";
import { runStatement, type Database } from "@anygriddb/db";
import { Decimal128, Long, MongoClient, ObjectId } from "mongodb";
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../../auth/key-ring.js";
import { loadEngine } from "../../data/engine.js";
import { aggregateRows, readPage } from "../../data/rows.js";
import { insertBase } from "../../data/schema-ops.js";
import { recordingBus } from "../../realtime/recording-bus.test-helpers.js";
import { createTestDatabase } from "../../test-database.js";
import { issueAuthority, issueServer } from "../../tls/certificate.js";
import {
  exposeTables,
  refreshExposedTable,
  setTableWrites,
} from "../expose.js";
import { setSourcePools, SourcePools } from "../pools.js";
import {
  checkConnection,
  createSource,
  exposedIn,
  sourceTables,
} from "../sources.js";
import { runSync, setTableSync } from "../sync.js";
import type { SourceConnection, SourceSettings } from "../types.js";

const settings: SourceSettings = {
  allows: (host) => host === "localhost" || host === "127.0.0.1",
  allowedHosts: ["localhost", "127.0.0.1"],
  allowPlaintext: false,
};

const BACKEND =
  "ghcr.io/ferretdb/postgres-documentdb:17-0.107.0-ferretdb-2.7.0";
const FERRETDB = "ghcr.io/ferretdb/ferretdb:2.7.0";

/** Invoices past one page of a copy, so a refresh reads several. */
const INVOICES = 2_500;

/** The row events waiting in the queue, by kind. */
async function queuedEvents(db: Database): Promise<string[]> {
  const jobs = await runStatement<{ payload: { event: { event: string } } }>(
    db,
    {
      text: `select p.payload from graphile_worker.jobs j join graphile_worker._private_jobs p on p.id = j.id where j.task_identifier = 'row_events'`,
      values: [],
    },
  );
  return jobs.map((job) => job.payload.event.event).sort();
}

/** The tables whose copy waits for a refresh. */
async function queuedCopies(db: Database): Promise<string[]> {
  const jobs = await runStatement<{ key: string }>(db, {
    text: `select key from graphile_worker.jobs where task_identifier = 'external_sync'`,
    values: [],
  });
  return jobs.map((job) => job.key.replace("external_sync:", "")).sort();
}

function columnOf(engine: EngineCatalog, stored: string): string {
  const column = engine.table.columns.find(
    (item) => item.physical?.name === stored,
  );
  if (!column) throw new Error(`no field for ${stored}`);
  return column.name;
}

describe("a MongoDB-protocol source, read from a copy", () => {
  let network: StartedNetwork | undefined;
  let backend: StartedTestContainer | undefined;
  let server: StartedTestContainer | undefined;
  let client: MongoClient | undefined;
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let pools: SourcePools | undefined;
  let admin = "";
  let certificate = "";
  let port = 0;
  let plainPort = 0;
  const key = keyRing(randomBytes(32));
  const ids = Array.from({ length: INVOICES }, () => new ObjectId());

  const connection = (): SourceConnection => ({
    engine: "mongodb",
    host: "localhost",
    port,
    database: "erp",
    username: "erp",
    password: "erp-pass-1",
    tlsCa: certificate,
    allowPlaintext: false,
    queryTimeoutMs: 15_000,
  });

  beforeAll(async () => {
    const authority = issueAuthority({
      commonName: "Test authority",
      names: ["localhost"],
    });
    const issued = issueServer({
      names: ["localhost"],
      authority: {
        cert: authority.cert,
        key: createPrivateKey(authority.key),
        publicKey: new X509Certificate(authority.cert).publicKey,
        commonName: "Test authority",
      },
    });
    certificate = authority.cert;
    network = await new Network().start();
    backend = await new GenericContainer(BACKEND)
      .withNetwork(network)
      .withNetworkAliases("backend")
      .withEnvironment({
        POSTGRES_USER: "erp",
        POSTGRES_PASSWORD: "erp-pass-1",
        POSTGRES_DB: "postgres",
      })
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .withStartupTimeout(180_000)
      .start();
    server = await new GenericContainer(FERRETDB)
      .withNetwork(network)
      .withEnvironment({
        FERRETDB_POSTGRESQL_URL:
          "postgres://erp:erp-pass-1@backend:5432/postgres",
        FERRETDB_LISTEN_TLS: ":27018",
        FERRETDB_LISTEN_TLS_CERT_FILE: "/tls/server.crt",
        FERRETDB_LISTEN_TLS_KEY_FILE: "/tls/server.key",
        FERRETDB_TELEMETRY: "disable",
      })
      .withCopyContentToContainer([
        { content: issued.cert, target: "/tls/server.crt", mode: 0o444 },
        {
          content: issued.key,
          target: "/tls/server.key",
          mode: 0o444,
        },
      ])
      // The image has no shell to probe a port with: its own readiness
      // page says when the backend answers.
      .withExposedPorts(27017, 27018, 8088)
      .withWaitStrategy(Wait.forHttp("/debug/readyz", 8088))
      .withStartupTimeout(120_000)
      .start();
    port = server.getMappedPort(27018);
    plainPort = server.getMappedPort(27017);

    // What a client's own application wrote there.
    client = new MongoClient(`mongodb://localhost:${String(port)}/`, {
      auth: { username: "erp", password: "erp-pass-1" },
      directConnection: true,
      tls: true,
      ca: certificate,
      serverSelectionTimeoutMS: 60_000,
    });
    await client.connect();
    const invoices = client.db("erp").collection("invoices");
    await invoices.insertMany(
      ids.map((id, index) => ({
        _id: id,
        number: index + 1,
        // A decimal kept exactly; the oldest two hold a text instead.
        amount:
          index < 2
            ? "to be confirmed"
            : Decimal128.fromString(`${String(index)}.10`),
        paid: index % 2 === 0,
        issued: new Date(Date.UTC(2026, 0, 1 + (index % 28), 9, 30)),
        customer: { name: `Customer ${String(index % 7)}`, vat: null },
        tags: index % 3 === 0 ? ["urgent", "export"] : [],
        ledger: Long.fromString("9007199254740993"),
        note: index === INVOICES - 1 ? "Paid by transfer.\nThank you." : null,
      })),
    );
    await client
      .db("erp")
      .collection("people")
      .insertMany([
        { _id: "ada" as unknown as ObjectId, name: "Ada", age: 36 },
        { _id: "bob" as unknown as ObjectId, name: "Bob", age: 41.5 },
      ]);

    const control = await createTestDatabase("mongodb_source");
    db = control.db;
    close = control.close;
    admin = (
      await db
        .insertInto("users")
        .values({
          email: "admin@example.com",
          displayName: "Admin",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await giveInstanceRole(db, admin, "administrator");
    pools = new SourcePools({ db, key, settings, log: () => undefined });
    setSourcePools(pools);
  }, 400_000);

  afterAll(async () => {
    setSourcePools(undefined);
    await pools?.close();
    await client?.close();
    await close?.();
    await server?.stop();
    await backend?.stop();
    await network?.stop();
  });

  it("signs in over verified TLS, and says why it cannot", async () => {
    const checked = await checkConnection(settings, connection());
    expect(checked.serverVersion).toMatch(/^FerretDB 2\.7\.0 \(MongoDB 7\./);

    const fails = async (source: SourceConnection, allow = settings) =>
      checkConnection(allow, source).then(
        () => "connected",
        (error: unknown) =>
          error instanceof AppError ? error.code : String(error),
      );
    // The system's authorities do not know the server's.
    expect(await fails({ ...connection(), tlsCa: null })).toBe(
      "source_tls_failed",
    );
    expect(await fails({ ...connection(), password: "wrong" })).toBe(
      "source_auth_failed",
    );
    // A listener without TLS is refused, not spoken to in clear.
    expect(await fails({ ...connection(), port: plainPort })).toBe(
      "source_tls_unavailable",
    );
    expect(await fails({ ...connection(), host: "db.example.org" })).toBe(
      "source_host_not_allowed",
    );
  });

  it("lists collections, copies them, and reads the copy like any table", async () => {
    const deps = { db, key, settings };
    const source = await createSource(deps, admin, {
      name: "ERP documents",
      ...connection(),
      connectionLimit: 2,
      timeZone: "UTC",
    });
    // No field of AnyGridDB's and no replica there: a copy takes neither.
    await expect(
      createSource(deps, admin, {
        name: "ERP with a side schema",
        ...connection(),
        connectionLimit: 2,
        timeZone: "UTC",
        sideSchema: "anygriddb",
      }),
    ).rejects.toMatchObject({ code: "source_copy_only" });

    const tables = await sourceTables(deps, source.id);
    expect(tables.map((table) => table.name)).toEqual(["invoices", "people"]);
    const [invoices, people] = tables;
    expect(invoices).toMatchObject({
      schema: "erp",
      kind: "table",
      primaryKey: ["_id"],
      estimatedRows: INVOICES,
      privileges: { insert: false, update: false, delete: false },
    });
    expect(
      invoices?.columns.map((column) => [
        column.name,
        column.type,
        column.field.fieldType,
      ]),
    ).toEqual([
      ["_id", "objectId", "text"],
      ["number", "int", "number"],
      ["amount", "decimal", "number"],
      ["paid", "bool", "boolean"],
      ["issued", "date", "datetime"],
      ["customer", "object", "json"],
      ["tags", "array", "json"],
      ["ledger", "bigint", "number"],
      ["note", "string", "long_text"],
    ]);
    // Whole numbers among others stay numbers.
    expect(people?.columns.map((column) => [column.name, column.type])).toEqual(
      [
        ["_id", "string"],
        ["name", "string"],
        ["age", "double"],
      ],
    );

    const base = await insertBase(db, admin, { name: "Documents" });
    const {
      tableIds: [invoicesId = "", peopleId = ""],
    } = await exposeTables(deps, admin, {
      sourceId: source.id,
      baseId: base.id,
      tables: [
        { schema: "erp", name: "invoices" },
        { schema: "erp", name: "people" },
      ],
    });

    const read = async (
      tableId: string,
      spec: Partial<Parameters<typeof readPage>[2]> = {},
    ) => {
      const { engine } = await loadEngine(db, tableId, () => true);
      const page = await readPage(
        db,
        engine,
        { limit: 50, timeZone: "UTC", ...spec },
        { total: true, exact: true },
      );
      return { engine, total: page.total, rows: page.rows };
    };

    // Each table's first copy is asked for as it is exposed.
    expect(await queuedCopies(db)).toEqual([invoicesId, peopleId].sort());

    // Read from its copy from the first moment: empty until it is filled.
    const before = await read(invoicesId);
    expect(before.engine.table.external?.synced).toBe(true);
    expect(before.total).toBe(0);

    const { bus, published } = recordingBus();
    const syncDeps = { db, bus, log: () => undefined };
    expect(await runSync(syncDeps, invoicesId)).toBe(60 * 60);
    expect(await runSync(syncDeps, peopleId)).toBe(60 * 60);
    // A first copy tells grids to read again, and no row event.
    expect(published.some((item) => item.channel.includes(invoicesId))).toBe(
      true,
    );
    expect(await queuedEvents(db)).toEqual([]);

    const copied = await read(invoicesId);
    expect(copied.total).toBe(INVOICES);
    const field = (name: string) => columnOf(copied.engine, name);

    // The newest invoice, every kind of value as its field reads it.
    const last = ids.at(-1)?.toHexString() ?? "";
    const {
      rows: [newest],
    } = await read(invoicesId, { rowIds: [last] });
    expect(newest).toMatchObject({
      id: last,
      [field("_id")]: last,
      [field("number")]: String(INVOICES),
      [field("amount")]: `${String(INVOICES - 1)}.10`,
      [field("paid")]: false,
      [field("ledger")]: "9007199254740993",
      [field("note")]: "Paid by transfer.\nThank you.",
    });
    expect(String(newest?.[field("issued")])).toMatch(/^2026-01-\d\dT09:30/);
    expect(JSON.parse(String(newest?.[field("customer")]))).toEqual({
      name: `Customer ${String((INVOICES - 1) % 7)}`,
      vat: null,
    });

    // The one read engine: a filter, a sort, a search, a total.
    const dear = await read(invoicesId, {
      filter: {
        conjunction: "and",
        conditions: [
          { column: field("amount"), op: "gt", value: "2497" },
          { column: field("paid"), op: "is", value: true },
        ],
      },
      sort: [{ column: field("number"), direction: "desc" }],
    });
    expect(dear.rows.map((row) => row[field("number")])).toEqual(["2499"]);
    expect((await read(invoicesId, { search: "Thank you" })).total).toBe(1);
    const { engine } = await loadEngine(db, invoicesId, () => true);
    expect(
      await aggregateRows(db, engine, { timeZone: "UTC" }, [
        { column: field("amount"), fn: "sum" },
        { column: field("amount"), fn: "count_empty" },
      ]),
    ).toEqual(["3123998.80", 2]);

    // The two texts where a number belongs read empty, and are counted.
    const exposures = await exposedIn(db, source.id);
    expect(exposures.get("erp.invoices")?.[0]?.sync).toMatchObject({
      rows: INVOICES,
      leftOut: 2,
      errorCode: null,
      intervalMinutes: 60,
    });

    // A text key names its rows as it is.
    const everyone = await read(peopleId, {
      sort: [
        {
          column: columnOf((await read(peopleId)).engine, "age"),
          direction: "asc",
        },
      ],
    });
    expect(everyone.rows.map((row) => row.id)).toEqual(["ada", "bob"]);

    // What the client's application changes arrives with the next copy.
    const store = client?.db("erp").collection("invoices");
    await store?.deleteOne({ _id: ids[10] });
    await store?.updateOne({ _id: ids[11] }, { $set: { paid: true } });
    const added = new ObjectId();
    await store?.insertOne({
      _id: added,
      number: INVOICES + 1,
      amount: Decimal128.fromString("12.50"),
      paid: false,
      issued: new Date(Date.UTC(2026, 1, 1)),
      customer: { name: "New" },
      tags: [],
      // A field the collection did not have.
      channel: "web",
    });
    expect(await runSync(syncDeps, invoicesId)).toBe(60 * 60);
    const refreshed = await read(invoicesId);
    expect(refreshed.total).toBe(INVOICES);
    expect(await queuedEvents(db)).toEqual(["delete", "insert", "update"]);

    // The new field becomes one when the table's fields are read again.
    const fields = await refreshExposedTable(deps, admin, invoicesId);
    expect(fields.added).toEqual(["channel"]);
    // A copy that lacks a field is made again at once, not at its turn.
    expect(await queuedCopies(db)).toContain(invoicesId);
    await runSync(syncDeps, invoicesId);
    const again = await read(invoicesId, { rowIds: [added.toHexString()] });
    expect(again.rows[0]?.[columnOf(again.engine, "channel")]).toBe("web");

    // A copy is all this store has: no live read, no write.
    await expect(
      setTableSync(db, admin, { tableId: invoicesId, intervalMinutes: null }),
    ).rejects.toMatchObject({ code: "source_copy_only" });
    await expect(
      setTableSync(db, admin, {
        tableId: invoicesId,
        intervalMinutes: 30,
        syncMode: "incremental",
        changeColumn: "issued",
      }),
    ).rejects.toMatchObject({ code: "source_copy_only" });
    await expect(
      setTableWrites(deps, admin, {
        tableId: invoicesId,
        update: true,
        insert: false,
        delete: false,
      }),
    ).rejects.toMatchObject({ code: "source_copy_only" });
    // Its interval is the one thing an administrator sets.
    await setTableSync(db, admin, { tableId: invoicesId, intervalMinutes: 30 });
    expect(await runSync(syncDeps, invoicesId)).toBe(30 * 60);
  });
});
