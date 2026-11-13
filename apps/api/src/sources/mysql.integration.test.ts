/**
 * Declaring MySQL and MariaDB sources over verified TLS, against servers
 * with a self-signed certificate that the test pastes as an administrator
 * would, and reading what their dedicated account may see.
 */
import { randomBytes } from "node:crypto";
import { AppError, describeColumns } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import { loadEngine } from "../data/engine.js";
import { aggregateRows, readPage } from "../data/rows.js";
import { addColumn, insertBase } from "../data/schema-ops.js";
import { createTestDatabase } from "../test-database.js";
import { exposeTables } from "./expose.js";
import { isAdministrator } from "./mysql.js";
import { introspectMysql } from "./mysql-schema.js";
import { setSourcePools, SourcePools, toPositional } from "./pools.js";
import { checkConnection, createSource } from "./sources.js";
import type { SourceConnection, SourceSettings } from "./types.js";

const settings: SourceSettings = {
  allows: (host) => host === "localhost" || host === "127.0.0.1",
  allowedHosts: ["localhost", "127.0.0.1"],
  allowPlaintext: false,
};

const SETUP = [
  "create user 'reader'@'%' identified by 'readerpass'",
  "create table customers (id int auto_increment primary key, name varchar(120) not null, active tinyint(1) not null default 1, meta json)",
  "create table invoices (id bigint primary key, customer_id int, amount decimal(14,2), status enum('draft','sent','it''s paid') not null default 'draft', issued date, sent_at datetime(3), note text, foreign key (customer_id) references customers(id)) comment 'Invoices sent to customers'",
  "create view unpaid as select id, amount from invoices where status <> 'it''s paid'",
  "create table salaries (id int primary key, amount decimal(10,2))",
  "insert into customers (name) values ('Ada'), ('Bob')",
  "insert into invoices values (1001, 1, 120.50, 'it''s paid', '2026-01-10', null, null), (1002, 1, 999999999999.99, 'sent', '2026-02-01', '2026-01-10 09:30:00.250', 'Long text')",
  "grant select on erp.customers to 'reader'@'%'",
  "grant select on erp.invoices to 'reader'@'%'",
  "grant select on erp.unpaid to 'reader'@'%'",
  "grant update (status) on erp.invoices to 'reader'@'%'",
].join("; ");

const FLAVORS: Array<{
  engine: "mysql" | "mariadb";
  image: string;
  server: string;
  client: string;
  env: Record<string, string>;
  version: RegExp;
}> = [
  {
    engine: "mysql",
    image: "mysql:8.4",
    server: "mysqld",
    client: "mysql",
    env: { MYSQL_ROOT_PASSWORD: "rootpass", MYSQL_DATABASE: "erp" },
    version: /^8\.4\./,
  },
  {
    engine: "mariadb",
    image: "mariadb:11.4",
    server: "mariadbd",
    client: "mariadb",
    env: { MARIADB_ROOT_PASSWORD: "rootpass", MARIADB_DATABASE: "erp" },
    version: /^11\.4\..*MariaDB/,
  },
];

describe.each(FLAVORS)("$engine sources", (flavor) => {
  let server: StartedTestContainer | undefined;
  let certificate = "";
  let port = 0;
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let admin = "";
  let pools: SourcePools | undefined;
  const key = keyRing(randomBytes(32));

  beforeAll(async () => {
    server = await new GenericContainer(flavor.image)
      .withEnvironment(flavor.env)
      .withExposedPorts(3306)
      .withEntrypoint(["bash", "-c"])
      .withCommand([
        [
          "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost",
          "-addext subjectAltName=DNS:localhost,IP:127.0.0.1",
          "-keyout /tmp/server.key -out /tmp/server.crt 2>/dev/null",
          "&& chown mysql /tmp/server.key /tmp/server.crt && chmod 600 /tmp/server.key",
          `&& exec docker-entrypoint.sh ${flavor.server}`,
          "--ssl-cert=/tmp/server.crt --ssl-key=/tmp/server.key",
          "--require-secure-transport=ON",
        ].join(" "),
      ])
      .withWaitStrategy(Wait.forLogMessage(/port: 3306/))
      .withStartupTimeout(180_000)
      .start();
    port = server.getMappedPort(3306);
    certificate = (await server.exec(["cat", "/tmp/server.crt"])).output;
    const created = await server.exec([
      flavor.client,
      "-uroot",
      "-prootpass",
      "erp",
      "-e",
      SETUP,
    ]);
    expect(created.exitCode, created.output).toBe(0);
    const control = await createTestDatabase(`source_${flavor.engine}`);
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
  });

  afterAll(async () => {
    setSourcePools(undefined);
    await pools?.close();
    await close?.();
    await server?.stop();
  });

  const connection = (patch: Partial<SourceConnection> = {}) => ({
    engine: flavor.engine,
    host: "localhost",
    port,
    database: "erp",
    username: "reader",
    password: "readerpass",
    tlsCa: certificate,
    queryTimeoutMs: 15_000,
    ...patch,
  });

  it("signs in a dedicated account over verified TLS", async () => {
    const checked = await checkConnection(settings, connection());
    expect(checked.serverVersion).toMatch(flavor.version);
    await expect(
      checkConnection(settings, connection({ host: "127.0.0.1" })),
    ).resolves.toMatchObject({ serverVersion: checked.serverVersion });
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
    expect(await refused({ username: "root", password: "rootpass" })).toBe(
      "source_admin_account",
    );
    expect(await refused({ password: "wrong" })).toBe("source_auth_failed");
    expect(await refused({ database: "missing" })).toBe(
      "source_unknown_database",
    );
    // MySQL and MariaDB differ: the server must be the engine chosen.
    expect(
      await refused({
        engine: flavor.engine === "mysql" ? "mariadb" : "mysql",
      }),
    ).toBe("source_engine_mismatch");
  });

  it("reads the tables the account may read, with their keys and rights", async () => {
    const tables = await introspectMysql(connection(), {
      allowPlaintext: false,
    });
    // `salaries` was never granted: the account does not see it.
    expect(tables.map((table) => `${table.schema}.${table.name}`)).toEqual([
      "erp.customers",
      "erp.invoices",
      "erp.unpaid",
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
          target: { schema: "erp", name: "customers" },
          targetColumns: ["id"],
        },
      ],
    });
    const column = (name: string) =>
      invoices?.columns.find((item) => item.name === name);
    expect(column("amount")?.field).toEqual({
      fieldType: "number",
      readOnly: false,
    });
    expect(column("status")).toMatchObject({
      canUpdate: true,
      field: {
        fieldType: "single_select",
        options: ["draft", "sent", "it's paid"],
      },
    });
    expect(column("amount")?.canUpdate).toBe(false);
    expect(column("sent_at")?.field.fieldType).toBe("datetime");
    expect(column("note")?.field.fieldType).toBe("long_text");
    const customers = tables.find((table) => table.name === "customers");
    expect(
      customers?.columns.find((item) => item.name === "active")?.field,
    ).toEqual({ fieldType: "boolean", readOnly: false });
    // MariaDB's JSON is a LONGTEXT whose check a reader cannot see.
    expect(
      customers?.columns.find((item) => item.name === "meta")?.field,
    ).toEqual({
      fieldType: "long_text",
      readOnly: flavor.engine === "mysql",
    });
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
      name: `Sales ${flavor.engine}`,
      ...connection(),
      connectionLimit: 3,
      timeZone: "Europe/Paris",
    });
    const base = await insertBase(db, admin, { name: "Sales" });
    const { tableIds } = await exposeTables(deps, admin, {
      sourceId: source.id,
      baseId: base.id,
      tables: [
        { schema: "erp", name: "customers" },
        { schema: "erp", name: "invoices" },
      ],
    });
    const [customersId = "", invoicesId = ""] = tableIds;
    const { engine } = await loadEngine(db, invoicesId, () => true);
    expect(engine.table.external).toMatchObject({
      dialect: flavor.engine,
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
    // A DATETIME has no zone: it is in the source's, 9:30 in Paris.
    expect(new Date(String(largest?.sent_at)).toISOString()).toBe(
      "2026-01-10T08:30:00.250Z",
    );
    expect(largest?.ag_seq).toBeNull();

    const ids = async (
      spec: Omit<Parameters<typeof readPage>[2], "limit" | "timeZone">,
    ) =>
      (await read({ ...spec, limit: 10, timeZone: "UTC" })).rows.map(
        (row) => row.id,
      );
    // Search, filters, and sorts run in the client's database.
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
    expect(
      await ids({
        filter: {
          conjunction: "and",
          conditions: [{ column: "customer_id", op: "contains", value: "ad" }],
        },
        sort: [{ column: "status", direction: "asc" }],
      }),
    ).toEqual(["1002", "1001"]);
    expect(
      await ids({
        filter: {
          conjunction: "and",
          conditions: [
            { column: "status", op: "is_any_of", value: ["it's paid"] },
          ],
        },
      }),
    ).toEqual(["1001"]);

    // Groups and footers.
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
        ["it's paid", 1, 1],
      ]),
    );
    const totals = await aggregateRows(db, engine, { timeZone: "UTC" }, [
      { column: "amount", fn: "sum" },
      { column: "sent_at", fn: "count_empty" },
      { column: "issued", fn: "earliest" },
    ]);
    expect(totals).toEqual(["1000000000120.49", 1, "2026-01-10"]);

    // The customer lists the invoices that point to it.
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

    // A formula computes in the client's database, as on PostgreSQL; one
    // MySQL computes in floating point runs, and its field says so.
    await addColumn(db, admin, invoicesId, {
      label: "Double",
      fieldType: "formula",
      formulaSource: "{amount} * 2",
    });
    const doubled = await readPage(
      db,
      (await loadEngine(db, invoicesId, () => true)).engine,
      { rowIds: ["1002"], limit: 1, timeZone: "UTC" },
      { total: false },
    );
    expect(doubled.rows[0]?.double).toBe("1999999999999.98");
    const root = await addColumn(db, admin, invoicesId, {
      label: "Root",
      fieldType: "formula",
      formulaSource: "SQRT({amount})",
    });
    const rooted = (await loadEngine(db, invoicesId, () => true)).engine;
    expect(
      describeColumns(rooted).find((column) => column.name === root.name)
        ?.limits,
    ).toEqual([{ code: "approximate", engine: flavor.engine, fn: "SQRT" }]);
    const roots = await readPage(
      db,
      rooted,
      { rowIds: ["1002"], limit: 1, timeZone: "UTC" },
      { total: false },
    );
    // To 15 significant digits, what a double holds.
    expect(roots.rows[0]?.[root.name]).toBe("999999.999999995");
  });
});

describe("placeholders for MySQL", () => {
  it("become positional, quoted text left alone", () => {
    expect(
      toPositional({
        text: `select json_extract(x, '$[0]'), "a$1", $2, $1, $2 from t where y = 'it''s $1'`,
        values: ["one", "two"],
      }),
    ).toEqual({
      text: `select json_extract(x, '$[0]'), "a$1", ?, ?, ? from t where y = 'it''s $1'`,
      values: ["two", "one", "two"],
    });
  });
});

describe("MySQL administrator accounts", () => {
  it("are told apart from dedicated ones by their global grants", () => {
    expect(
      isAdministrator([
        "GRANT USAGE ON *.* TO `reader`@`%`",
        "GRANT SELECT, UPDATE (`status`) ON `erp`.`invoices` TO `reader`@`%`",
      ]),
    ).toBe(false);
    expect(isAdministrator(["GRANT SELECT ON *.* TO `reader`@`%`"])).toBe(
      false,
    );
    for (const grant of [
      "GRANT ALL PRIVILEGES ON *.* TO `root`@`%` WITH GRANT OPTION",
      "GRANT SELECT ON *.* TO `r`@`%` WITH GRANT OPTION",
      "GRANT SUPER ON *.* TO `ops`@`%`",
      "GRANT CREATE USER ON *.* TO `ops`@`%`",
      "GRANT SELECT, CREATE, DROP ON *.* TO `ops`@`%`",
      "GRANT SYSTEM_VARIABLES_ADMIN ON *.* TO `ops`@`%`",
    ]) {
      expect(isAdministrator([grant]), grant).toBe(true);
    }
  });
});
