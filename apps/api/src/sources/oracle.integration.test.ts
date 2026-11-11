/**
 * Oracle Free as an external source (ADRs 0024, 0047): thin-mode sign-in,
 * a dedicated account's view of another schema, verified TLS, and a bound
 * page read through the product path. The formulas, writes, and the rest
 * are in the conformance suite.
 *
 * The Free image has no TLS listener: a TLS front, as a proxy or a load
 * balancer would be, carries the link to it, with a certificate from a
 * test authority.
 */
import { createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { connect, type AddressInfo } from "node:net";
import { createServer, type Server } from "node:tls";
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import oracledb from "oracledb";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEngine } from "../data/engine.js";
import { readPage } from "../data/rows.js";
import { insertBase } from "../data/schema-ops.js";
import { createTestDatabase } from "../test-database.js";
import { issueAuthority, issueServer } from "../tls/certificate.js";
import { exposeTables } from "./expose.js";
import { setSourcePools, SourcePools } from "./pools.js";
import { checkConnection, createSource } from "./sources.js";
import { introspectOracle } from "./oracle-schema.js";
import type { SourceConnection, SourceSettings } from "./types.js";

const LOCAL = ["localhost", "127.0.0.1", "127.0.0.2"];
const settings: SourceSettings = {
  allows: (host) => LOCAL.includes(host),
  allowedHosts: LOCAL,
  allowPlaintext: true,
};
const verified: SourceSettings = { ...settings, allowPlaintext: false };

const SYSTEM_PASSWORD = "Anygrid_Oracle_19";

/** A TLS front on `address`, its certificate for 127.0.0.1 only. */
async function tlsFront(
  address: string,
  upstream: number,
  identity: { key: string; cert: string },
): Promise<{ server: Server; port: number }> {
  const server = createServer(identity, (socket) => {
    const link = connect(upstream, "127.0.0.1");
    socket.pipe(link).pipe(socket);
    socket.on("error", () => link.destroy());
    link.on("error", () => socket.destroy());
  });
  server.listen(0, address);
  await once(server, "listening");
  return { server, port: (server.address() as AddressInfo).port };
}

describe("Oracle sources", () => {
  let oracle: StartedTestContainer | undefined;
  let port = 0;
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let admin = "";
  let pools: SourcePools | undefined;
  const fronts: Server[] = [];
  const key = randomBytes(32);

  beforeAll(async () => {
    oracle = await new GenericContainer("gvenzl/oracle-free:23-slim-faststart")
      .withEnvironment({
        ORACLE_PASSWORD: SYSTEM_PASSWORD,
        APP_USER: "sales",
        APP_USER_PASSWORD: "Sales_Owner_19",
      })
      .withExposedPorts(1521)
      .withWaitStrategy(Wait.forLogMessage(/DATABASE IS READY TO USE/i))
      .withStartupTimeout(600_000)
      .start();
    port = oracle.getMappedPort(1521);
    const connectString = `localhost:${String(port)}/FREEPDB1`;
    // The owner's tables, named as Oracle names them: in capitals.
    const owner = await oracledb.getConnection({
      user: "sales",
      password: "Sales_Owner_19",
      connectString,
    });
    for (const statement of [
      "create table customers (id number(10) primary key, name varchar2(120) not null, amount number(14,2), active number(1) default 1 not null, notes blob)",
      "insert into customers (id, name, amount, active) values (1, 'Ada', 120.50, 1)",
      "insert into customers (id, name, amount, active) values (2, 'Bob', 10, 0)",
      "create table secrets (id number(10) primary key, code varchar2(20))",
    ]) {
      await owner.execute(statement);
    }
    await owner.commit();
    await owner.close();
    // The dedicated account docs/sources.md asks for: what it may read
    // and change, granted column by column.
    const system = await oracledb.getConnection({
      user: "system",
      password: SYSTEM_PASSWORD,
      connectString,
    });
    for (const statement of [
      "create user grid identified by Grid_Reader_19",
      "grant create session to grid",
      "grant select on sales.customers to grid",
      "grant update (name, active) on sales.customers to grid",
    ]) {
      await system.execute(statement);
    }
    await system.close();

    const control = await createTestDatabase("source_oracle");
    db = control.db;
    close = control.close;
    admin = (
      await db
        .insertInto("users")
        .values({
          email: "admin@example.com",
          displayName: "Admin",
          isAdmin: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  }, 660_000);

  afterAll(async () => {
    for (const front of fronts) front.close();
    setSourcePools(undefined);
    await pools?.close();
    await close?.();
    await oracle?.stop();
  });

  const connection = (
    patch: Partial<SourceConnection> = {},
  ): SourceConnection => ({
    engine: "oracle",
    host: "localhost",
    port,
    database: "FREEPDB1",
    username: "grid",
    password: "Grid_Reader_19",
    tlsCa: null,
    queryTimeoutMs: 15_000,
    ...patch,
  });

  const outcome = (promise: Promise<unknown>) =>
    promise.then(
      () => "connected",
      (error: unknown) =>
        error instanceof AppError ? error.code : String(error),
    );

  it("signs in a dedicated account in thin mode, never an administrator", async () => {
    const checked = await checkConnection(settings, connection());
    expect(checked.serverVersion).toMatch(/^2\d\./);
    expect(
      await outcome(
        checkConnection(settings, connection({ password: "wrong" })),
      ),
    ).toBe("source_auth_failed");
    expect(
      await outcome(
        checkConnection(
          settings,
          connection({ username: "system", password: SYSTEM_PASSWORD }),
        ),
      ),
    ).toBe("source_admin_account");
    expect(
      await outcome(
        checkConnection(settings, connection({ database: "FREEPDB1)(X=" })),
      ),
    ).toBe("source_unknown_database");
  });

  it("connects over verified TLS only, to the name its certificate gives", async () => {
    const authority = issueAuthority({
      commonName: "Test authority",
      names: ["127.0.0.1", "127.0.0.2"],
    });
    const other = issueAuthority({
      commonName: "Another authority",
      names: ["127.0.0.1"],
    });
    const server = issueServer({
      names: ["127.0.0.1"],
      authority: {
        cert: authority.cert,
        key: createPrivateKey(authority.key),
        publicKey: new X509Certificate(authority.cert).publicKey,
        commonName: "Test authority",
      },
    });
    const identity = { key: server.key, cert: server.cert + authority.cert };
    const [named, misnamed] = await Promise.all([
      tlsFront("127.0.0.1", port, identity),
      tlsFront("127.0.0.2", port, identity),
    ]);
    fronts.push(named.server, misnamed.server);
    const through = (host: string, front: number, tlsCa: string | null) =>
      outcome(
        checkConnection(verified, connection({ host, port: front, tlsCa })),
      );
    expect(await through("127.0.0.1", named.port, authority.cert)).toBe(
      "connected",
    );
    expect(await through("127.0.0.1", named.port, other.cert)).toBe(
      "source_tls_failed",
    );
    expect(await through("127.0.0.2", misnamed.port, authority.cert)).toBe(
      "source_tls_failed",
    );
    // No authority, no development flag: no plaintext either.
    expect(await through("127.0.0.1", port, null)).toBe(
      "source_tls_unavailable",
    );
  });

  it("lists what the account may read, and what it may change", async () => {
    const tables = await introspectOracle(connection(), {
      allowPlaintext: true,
    });
    expect(tables.map((table) => `${table.schema}.${table.name}`)).toEqual([
      "SALES.CUSTOMERS",
    ]);
    const [customers] = tables;
    expect(customers).toMatchObject({
      kind: "table",
      primaryKey: ["ID"],
      privileges: { insert: false, update: true, delete: false },
    });
    const columns = Object.fromEntries(
      (customers?.columns ?? []).map((column) => [column.name, column]),
    );
    expect(columns.AMOUNT?.field.fieldType).toBe("number");
    expect(columns.ACTIVE?.field.fieldType).toBe("boolean");
    expect(columns.NOTES?.field).toEqual({ fieldType: "text", readOnly: true });
    expect(
      Object.values(columns)
        .filter((column) => column.canUpdate)
        .map((column) => column.name),
    ).toEqual(["NAME", "ACTIVE"]);
  }, 120_000);

  it("exposes a client's table and reads a bound page", async () => {
    const deps = { db, key, settings };
    pools = new SourcePools({ db, key, settings, log: () => undefined });
    setSourcePools(pools);
    const source = await createSource(deps, admin, {
      name: "Sales",
      ...connection(),
      connectionLimit: 3,
      timeZone: "UTC",
    });
    const base = await insertBase(db, admin, { name: "Sales" });
    const {
      tableIds: [tableId = ""],
    } = await exposeTables(deps, admin, {
      sourceId: source.id,
      baseId: base.id,
      tables: [{ schema: "SALES", name: "CUSTOMERS" }],
    });
    const { engine } = await loadEngine(db, tableId, () => true);
    expect(engine.table.external).toMatchObject({ dialect: "oracle" });
    const field = (name: string) =>
      engine.table.columns.find((column) => column.physical?.name === name)
        ?.name ?? "";
    const page = await readPage(
      db,
      engine,
      {
        sort: [{ column: field("AMOUNT"), direction: "desc" }],
        limit: 10,
        timeZone: "UTC",
      },
      { total: true },
    );
    expect(page.total).toBe(2);
    expect(
      page.rows.map((row) => [
        row.id,
        row[field("NAME")],
        row[field("AMOUNT")],
        row[field("ACTIVE")],
      ]),
    ).toEqual([
      ["1", "Ada", "120.5", true],
      ["2", "Bob", "10", false],
    ]);
  }, 180_000);
});
