/**
 * Declaring a SQL Server source over verified TLS, against a server that
 * forces encryption with a self-signed certificate the test pastes as an
 * administrator would, and reading what its dedicated account may see.
 */
import { randomBytes } from "node:crypto";
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEngine } from "../data/engine.js";
import { aggregateRows, readPage } from "../data/rows.js";
import { addColumn, insertBase } from "../data/schema-ops.js";
import { createTestDatabase } from "../test-database.js";
import { exposeTables } from "./expose.js";
import { setSourcePools, SourcePools } from "./pools.js";
import { checkConnection, createSource } from "./sources.js";
import { introspectSqlServer } from "./sqlserver-schema.js";
import type { SourceConnection, SourceSettings } from "./types.js";

const settings: SourceSettings = {
  allows: (host) => host === "localhost" || host === "127.0.0.1",
  allowedHosts: ["localhost", "127.0.0.1"],
  allowPlaintext: false,
};

const SA_PASSWORD = "Admin!Passw0rd-2026";
const READER_PASSWORD = "Reader!Passw0rd-2026";

const SETUP = [
  "create database erp",
  "go",
  "use erp",
  `create login reader with password = '${READER_PASSWORD}', check_policy = off`,
  "create user reader for login reader",
  "create table customers (id int identity primary key, name nvarchar(120) not null, active bit not null default 1, guid uniqueidentifier default newid())",
  "create table invoices (id bigint primary key, customer_id int references customers(id), amount decimal(14,2), status nvarchar(20) not null default 'draft', issued date, sent_at datetime2(3), note nvarchar(max))",
  "exec sp_addextendedproperty 'MS_Description', 'Invoices sent to customers', 'SCHEMA', 'dbo', 'TABLE', 'invoices'",
  "go",
  "create view unpaid as select id, amount from invoices where status <> 'paid'",
  "go",
  "create table salaries (id int primary key, amount decimal(10,2))",
  "create table lines (invoice_id bigint, line_no int, label nvarchar(50), primary key (invoice_id, line_no))",
  "insert into lines values (1001, 1, N'Design'), (1001, 2, N'Build')",
  "grant select on lines to reader",
  "insert into customers (name) values ('Ada'), ('Bob')",
  "insert into invoices values (1001, 1, 120.50, 'paid', '2026-01-10', null, null), (1002, 1, 999999999999.99, 'sent', '2026-02-01', '2026-01-10 09:30:00.250', N'Long text')",
  "grant select on customers to reader",
  "grant select on invoices to reader",
  "grant select on unpaid to reader",
  "grant update (status) on invoices to reader",
].join("\n");

describe("SQL Server sources", () => {
  let server: StartedTestContainer | undefined;
  let certificate = "";
  let port = 0;
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let admin = "";
  let pools: SourcePools | undefined;
  const key = randomBytes(32);

  beforeAll(async () => {
    server = await new GenericContainer(
      "mcr.microsoft.com/mssql/server:2022-latest",
    )
      .withEnvironment({ ACCEPT_EULA: "Y", MSSQL_SA_PASSWORD: SA_PASSWORD })
      .withExposedPorts(1433)
      .withEntrypoint(["bash", "-c"])
      .withCommand([
        [
          "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost",
          "-addext subjectAltName=DNS:localhost,IP:127.0.0.1",
          "-keyout /var/opt/mssql/server.key -out /var/opt/mssql/server.crt 2>/dev/null",
          "&& chmod 600 /var/opt/mssql/server.key",
          "&& printf '[network]\\ntlscert = /var/opt/mssql/server.crt\\ntlskey = /var/opt/mssql/server.key\\ntlsprotocols = 1.2\\nforceencryption = 1\\n' > /var/opt/mssql/mssql.conf",
          "&& exec /opt/mssql/bin/sqlservr",
        ].join(" "),
      ])
      .withWaitStrategy(
        Wait.forLogMessage(/SQL Server is now ready for client connections/),
      )
      .withStartupTimeout(240_000)
      .start();
    port = server.getMappedPort(1433);
    certificate = (await server.exec(["cat", "/var/opt/mssql/server.crt"]))
      .output;
    await server.exec([
      "bash",
      "-c",
      `cat > /tmp/setup.sql <<'SQL'\n${SETUP}\nSQL`,
    ]);
    const sqlcmd = (...args: string[]) =>
      server?.exec([
        "/opt/mssql-tools18/bin/sqlcmd",
        "-S",
        "localhost",
        "-U",
        "sa",
        "-P",
        SA_PASSWORD,
        "-C",
        "-b",
        ...args,
      ]);
    // "Ready" comes before the server finishes its own scripts: sa may be
    // refused for a few seconds more.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if ((await sqlcmd("-Q", "select 1"))?.exitCode === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const created = await sqlcmd("-i", "/tmp/setup.sql");
    expect(created?.exitCode, created?.output).toBe(0);
    const control = await createTestDatabase("source_sqlserver");
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
  }, 300_000);

  afterAll(async () => {
    setSourcePools(undefined);
    await pools?.close();
    await close?.();
    await server?.stop();
  });

  const connection = (patch: Partial<SourceConnection> = {}) => ({
    engine: "sqlserver" as const,
    host: "localhost",
    port,
    database: "erp",
    username: "reader",
    password: READER_PASSWORD,
    tlsCa: certificate,
    queryTimeoutMs: 15_000,
    ...patch,
  });

  it("signs in a dedicated account over verified TLS", async () => {
    const checked = await checkConnection(settings, connection());
    expect(checked.serverVersion).toMatch(/^16\./);
  });

  it("refuses what ADR 0026 refuses", async () => {
    const refused = (patch: Partial<SourceConnection>) =>
      checkConnection(settings, connection(patch)).then(
        () => "connected",
        (error: unknown) =>
          error instanceof AppError ? error.code : String(error),
      );
    // A certificate nobody pasted is not trusted.
    expect(await refused({ tlsCa: null })).toBe("source_tls_failed");
    expect(await refused({ username: "sa", password: SA_PASSWORD })).toBe(
      "source_admin_account",
    );
    expect(await refused({ password: "wrong" })).toBe("source_auth_failed");
    expect(await refused({ database: "missing" })).toBe(
      "source_unknown_database",
    );
  });

  it("reads the tables the account may read, with their keys and rights", async () => {
    const tables = await introspectSqlServer(connection(), {
      allowPlaintext: false,
    });
    // `salaries` was never granted: the account does not see it.
    expect(tables.map((table) => `${table.schema}.${table.name}`)).toEqual([
      "dbo.customers",
      "dbo.invoices",
      "dbo.lines",
      "dbo.unpaid",
    ]);
    const invoices = tables.find((table) => table.name === "invoices");
    expect(invoices).toMatchObject({
      kind: "table",
      comment: "Invoices sent to customers",
      primaryKey: ["id"],
      privileges: { insert: false, update: true, delete: false },
      foreignKeys: [
        {
          columns: ["customer_id"],
          target: { schema: "dbo", name: "customers" },
          targetColumns: ["id"],
        },
      ],
    });
    const column = (name: string) =>
      invoices?.columns.find((item) => item.name === name);
    expect(column("amount")).toMatchObject({
      type: "decimal(14,2)",
      field: { fieldType: "number", readOnly: false },
      canUpdate: false,
    });
    expect(column("status")).toMatchObject({
      type: "nvarchar(20)",
      canUpdate: true,
      field: { fieldType: "text" },
    });
    expect(column("sent_at")?.field.fieldType).toBe("datetime");
    expect(column("note")?.field.fieldType).toBe("long_text");
    const customers = tables.find((table) => table.name === "customers");
    expect(
      customers?.columns.find((item) => item.name === "active")?.field,
    ).toEqual({ fieldType: "boolean", readOnly: false });
    expect(
      customers?.columns.find((item) => item.name === "guid")?.field,
    ).toEqual({ fieldType: "text", readOnly: true });
    expect(tables.find((table) => table.name === "unpaid")).toMatchObject({
      kind: "view",
      primaryKey: [],
      privileges: { insert: false, update: false, delete: false },
    });
  });

  it("exposes a client's tables in a base and reads them where they live", async () => {
    const deps = { db, key, settings };
    pools = new SourcePools({ db, key, settings, log: () => undefined });
    setSourcePools(pools);
    const source = await createSource(deps, admin, {
      name: "Sales sqlserver",
      ...connection(),
      connectionLimit: 3,
      timeZone: "Europe/Paris",
    });
    const base = await insertBase(db, admin, { name: "Sales" });
    const { tableIds } = await exposeTables(deps, admin, {
      sourceId: source.id,
      baseId: base.id,
      tables: [
        { schema: "dbo", name: "customers" },
        { schema: "dbo", name: "invoices" },
        { schema: "dbo", name: "lines" },
      ],
    });
    const [customersId = "", invoicesId = "", linesId = ""] = tableIds;
    // A key of two columns names a row by both, and finds it again.
    const lines = (await loadEngine(db, linesId, () => true)).engine;
    const listed = await readPage(
      db,
      lines,
      { limit: 10, timeZone: "UTC" },
      { total: false },
    );
    const second = listed.rows.find((row) => row.label === "Build");
    expect(second?.id).toBe('{"k0":1001,"k1":2}');
    const found = await readPage(
      db,
      lines,
      { rowIds: [String(second?.id)], limit: 1, timeZone: "UTC" },
      { total: false },
    );
    expect(found.rows.map((row) => row.label)).toEqual(["Build"]);
    const { engine } = await loadEngine(db, invoicesId, () => true);
    expect(engine.table.external).toMatchObject({
      dialect: "sqlserver",
      name: "invoices",
      key: ["id"],
    });
    const read = (spec: Parameters<typeof readPage>[2]) =>
      readPage(db, engine, spec, { total: true });

    const page = await read({
      sort: [{ column: "amount", direction: "desc" }],
      limit: 10,
      timeZone: "UTC",
    });
    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row.id)).toEqual(["1002", "1001"]);
    const [largest] = page.rows;
    // Exact numbers, as the client holds them (ADR 0023).
    expect(largest?.amount).toBe("999999999999.99");
    expect(largest?.status).toBe("sent");
    expect(largest?.note).toBe("Long text");
    expect(largest?.issued).toBe("2026-02-01");
    // The foreign key reads as a link to the customer, by its name.
    expect(largest?.customer_id).toEqual([{ id: "1", label: "Ada" }]);
    // A datetime2 has no zone: it is in the source's, 9:30 in Paris.
    expect(largest?.sent_at).toBe("2026-01-10T08:30:00.25+00:00");
    expect(largest?.ag_seq).toBeNull();

    const ids = async (
      spec: Omit<Parameters<typeof readPage>[2], "limit" | "timeZone">,
    ) =>
      (await read({ ...spec, limit: 10, timeZone: "Europe/Paris" })).rows.map(
        (row) => row.id,
      );
    expect(await ids({ search: "sent" })).toEqual(["1002"]);
    expect(await ids({ rowIds: ["1001"] })).toEqual(["1001"]);
    expect(
      await ids({
        filter: {
          conjunction: "and",
          conditions: [{ column: "amount", op: "gt", value: "1000" }],
        },
      }),
    ).toEqual(["1002"]);
    expect(
      await ids({
        filter: {
          conjunction: "and",
          conditions: [
            {
              column: "issued",
              op: "is_before",
              value: { mode: "exact", date: "2026-01-15" },
            },
          ],
        },
      }),
    ).toEqual(["1001"]);
    // A day in the reader's zone: 08:30 UTC is January 10th in Paris.
    expect(
      await ids({
        filter: {
          conjunction: "and",
          conditions: [
            {
              column: "sent_at",
              op: "is",
              value: { mode: "exact", date: "2026-01-10" },
            },
          ],
        },
      }),
    ).toEqual(["1002"]);
    expect(
      await ids({
        filter: {
          conjunction: "and",
          conditions: [{ column: "customer_id", op: "contains", value: "ad" }],
        },
        sort: [{ column: "status", direction: "asc" }],
      }),
    ).toEqual(["1001", "1002"]);
    expect(
      await ids({
        filter: {
          conjunction: "and",
          conditions: [{ column: "status", op: "is_any_of", value: ["paid"] }],
        },
      }),
    ).toEqual(["1001"]);

    const grouped = await read({
      groupBy: [{ column: "status", direction: "asc" }],
      limit: 10,
      timeZone: "UTC",
    });
    expect(
      grouped.groups.map((group) => [group.keys[0], group.depth, group.count]),
    ).toEqual(
      expect.arrayContaining([
        ["sent", 1, 1],
        ["paid", 1, 1],
      ]),
    );
    const totals = await aggregateRows(db, engine, { timeZone: "UTC" }, [
      { column: "amount", fn: "sum" },
      { column: "sent_at", fn: "count_empty" },
      { column: "issued", fn: "earliest" },
    ]);
    expect(totals).toEqual(["1000000000120.49", 1, "2026-01-10"]);

    const customers = await loadEngine(db, customersId, () => true);
    const people = await readPage(
      db,
      customers.engine,
      { limit: 10, timeZone: "UTC" },
      { total: false },
    );
    expect(people.rows.map((row) => row.name)).toEqual(["Ada", "Bob"]);
    expect(people.rows[0]?.active).toBe(true);
    expect(
      (people.rows[0]?.invoices as Array<{ id: string }>).map(
        (link) => link.id,
      ),
    ).toEqual(["1001", "1002"]);

    // Formulas compute in the client's database, exact where T-SQL's
    // decimals hold the result (the conformance suite runs the rest).
    const doubled = await addColumn(db, admin, invoicesId, {
      label: "Double",
      fieldType: "formula",
      formulaSource: "{amount} * 2",
    });
    const third = await addColumn(db, admin, invoicesId, {
      label: "Third",
      fieldType: "formula",
      formulaSource: "{amount} / 3",
    });
    const computed = await readPage(
      db,
      (await loadEngine(db, invoicesId, () => true)).engine,
      { rowIds: ["1002"], limit: 1, timeZone: "UTC" },
      { total: false },
    );
    expect(computed.rows[0]?.[doubled.name]).toBe("1999999999999.98");
    expect(computed.rows[0]?.[third.name]).toBe("333333333333.33");
  });
});
