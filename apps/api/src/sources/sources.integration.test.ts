/**
 * Declaring a PostgreSQL source over verified TLS, against a server with a
 * self-signed certificate that the test pastes as an administrator would.
 */
import { removeTable } from "../data/tables.js";
import { addComment, countComments } from "../data/comments.js";
import { randomBytes } from "node:crypto";
import { AppError, buildReadRows } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEngine } from "../data/engine.js";
import { grantMember } from "../data/members.js";
import type { Env } from "../env.js";
import { browserFactory } from "../trpc/caller.test-helpers.js";
import { readPage } from "../data/rows.js";
import { addColumn, insertBase } from "../data/schema-ops.js";
import { loadRowScope, updateRows } from "../services/rows.js";
import { createTestDatabase } from "../test-database.js";
import { exposeTables, refreshExposedTable } from "./expose.js";
import { setSourcePools, SourcePools } from "./pools.js";
import {
  checkConnection,
  createSource,
  deleteSource,
  listSources,
  recheckSource,
  sourceTables,
  updateSource,
} from "./sources.js";
import type { SourceSettings } from "./types.js";

const settings: SourceSettings = {
  allows: (host) => host === "localhost" || host === "127.0.0.1",
  allowedHosts: ["localhost", "127.0.0.1"],
  allowPlaintext: false,
};

describe("PostgreSQL sources", () => {
  let server: StartedTestContainer | undefined;
  let certificate = "";
  let port = 0;
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let admin = "";
  const key = randomBytes(32);
  let pools: SourcePools | undefined;

  beforeAll(async () => {
    server = await new GenericContainer("postgres:17")
      .withEnvironment({ POSTGRES_PASSWORD: "superpass", POSTGRES_DB: "erp" })
      .withExposedPorts(5432)
      .withEntrypoint(["bash", "-c"])
      .withCommand([
        [
          "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost",
          "-addext subjectAltName=DNS:localhost,IP:127.0.0.1",
          "-keyout /tmp/server.key -out /tmp/server.crt 2>/dev/null",
          "&& chown postgres /tmp/server.key /tmp/server.crt && chmod 600 /tmp/server.key",
          "&& exec docker-entrypoint.sh postgres -c ssl=on",
          "-c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key",
        ].join(" "),
      ])
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    port = server.getMappedPort(5432);
    certificate = (await server.exec(["cat", "/tmp/server.crt"])).output;
    const created = await server.exec([
      "psql",
      "-U",
      "postgres",
      "-d",
      "erp",
      "-c",
      [
        "create role anygriddb login password 'readerpass'",
        "create type invoice_status as enum ('draft', 'sent', 'paid')",
        "create domain cents as bigint check (value >= 0)",
        "create table customers (id serial primary key, name varchar(120) not null, tags text[])",
        "create table invoices (id bigint primary key, customer_id int references customers(id), amount numeric(14,2), total cents, status invoice_status not null default 'draft', issued date, meta jsonb, sent_at timestamp)",
        "comment on table invoices is 'Invoices sent to customers'",
        "create view unpaid as select id, amount from invoices where status <> 'paid'",
        "create table salaries (id int primary key, amount numeric)",
        "insert into customers (name) values ('Ada'), ('Bob')",
        "insert into invoices values (1001, 1, 120.50, 12050, 'paid', '2026-01-10', null, null), (1002, 1, 99999999999.99, 0, 'sent', '2026-02-01', null, '2026-01-10 09:30:00'), (1003, 2, 7.25, 725, 'draft', null, null, null)",
        "create table events (id int primary key, kind text not null)",
        "insert into events select g, case when g % 2 = 0 then 'even' else 'odd' end from generate_series(1, 20000) g",
        "analyze events",
        "grant select on customers, invoices, unpaid, events to anygriddb",
        "grant update (status) on invoices to anygriddb",
      ].join("; "),
    ]);
    expect(created.exitCode).toBe(0);
    const control = await createTestDatabase("sources");
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

  const connection = (patch: Record<string, unknown> = {}) => ({
    engine: "postgres" as const,
    host: "localhost",
    port,
    database: "erp",
    username: "anygriddb",
    password: "readerpass",
    tlsCa: certificate,
    queryTimeoutMs: 15_000,
    timeZone: "UTC",
    ...patch,
  });

  it("signs in a dedicated account over verified TLS", async () => {
    const checked = await checkConnection(settings, connection());
    expect(checked.serverVersion).toMatch(/^17\./);
    // By address too: the certificate names 127.0.0.1.
    await expect(
      checkConnection(settings, connection({ host: "127.0.0.1" })),
    ).resolves.toMatchObject({ serverVersion: checked.serverVersion });
  });

  it("refuses what ADR 0026 refuses", async () => {
    const refused = (patch: Record<string, unknown>) =>
      checkConnection(settings, connection(patch)).then(
        () => "connected",
        (error: unknown) =>
          error instanceof AppError ? error.code : String(error),
      );
    // A certificate nobody pasted is not trusted.
    expect(await refused({ tlsCa: null })).toBe("source_tls_failed");
    expect(await refused({ host: "db.elsewhere.example" })).toBe(
      "source_host_not_allowed",
    );
    expect(await refused({ username: "postgres", password: "superpass" })).toBe(
      "source_admin_account",
    );
    expect(await refused({ password: "wrong" })).toBe("source_auth_failed");
    expect(await refused({ database: "missing" })).toBe(
      "source_unknown_database",
    );
    // A PostgreSQL server is not the engine chosen: nothing signs in.
    expect(await refused({ engine: "sqlserver" })).toBe("source_unreachable");
  });

  it("reads the tables the account may read, with their keys and rights", async () => {
    const deps = { db, key, settings };
    const created = await createSource(deps, admin, {
      name: "Catalog",
      ...connection(),
      connectionLimit: 5,
    });
    const tables = await sourceTables(deps, created.id);
    // `salaries` was never granted: the account does not see it.
    expect(tables.map((table) => `${table.schema}.${table.name}`)).toEqual([
      "public.customers",
      "public.events",
      "public.invoices",
      "public.unpaid",
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
          target: { schema: "public", name: "customers" },
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
    // A domain reads as the type it is built on.
    expect(column("total")?.field.fieldType).toBe("number");
    expect(column("status")).toMatchObject({
      canUpdate: true,
      field: { fieldType: "single_select", options: ["draft", "sent", "paid"] },
    });
    expect(column("amount")?.canUpdate).toBe(false);
    expect(column("meta")?.field.readOnly).toBe(true);
    expect(
      tables
        .find((table) => table.name === "customers")
        ?.columns.find((item) => item.name === "tags")?.field,
    ).toEqual({ fieldType: "long_text", readOnly: true });
    expect(tables.find((table) => table.name === "unpaid")).toMatchObject({
      kind: "view",
      primaryKey: [],
      privileges: { insert: false, update: false, delete: false },
    });
    await deleteSource(deps, admin, created.id);
  });

  it("exposes a client's tables in a base and reads them where they live", async () => {
    const deps = { db, key, settings };
    pools = new SourcePools({ db, key, settings, log: () => undefined });
    setSourcePools(pools);
    const source = await createSource(deps, admin, {
      name: "Sales",
      ...connection({ timeZone: "Europe/Paris" }),
      connectionLimit: 3,
    });
    const base = await insertBase(db, admin, { name: "Sales" });
    const { tableIds } = await exposeTables(deps, admin, {
      sourceId: source.id,
      baseId: base.id,
      tables: [
        { schema: "public", name: "customers" },
        { schema: "public", name: "invoices" },
      ],
    });
    expect(tableIds).toHaveLength(2);
    const invoicesId = tableIds[1] ?? "";
    const { engine } = await loadEngine(db, invoicesId, () => true);
    // Numbers show as the client's types say: a key without separators,
    // a numeric(14,2) with its two decimals.
    const columns = new Map(
      engine.table.columns.map((column) => [column.name, column.config]),
    );
    expect(columns.get("f_id")).toEqual({
      number: { precision: 0, thousands: false },
    });
    expect(columns.get("amount")).toEqual({ number: { precision: 2 } });
    expect(engine.table.external).toMatchObject({
      schema: "public",
      name: "invoices",
      key: ["id"],
    });
    const page = await readPage(
      db,
      engine,
      {
        sort: [{ column: "amount", direction: "desc" }],
        limit: 10,
        timeZone: "UTC",
      },
      { total: true },
    );
    expect(page.total).toBe(3);
    expect(page.rows.map((row) => row.id)).toEqual(["1002", "1001", "1003"]);
    const [largest] = page.rows;
    // Exact numbers, as the client's database holds them (ADR 0023).
    expect(largest?.amount).toBe("99999999999.99");
    expect(largest?.status).toBe("sent");
    // A timestamp without a zone reads in the source's: 9:30 in Paris.
    expect(new Date(largest?.sent_at as string | Date).toISOString()).toBe(
      "2026-01-10T08:30:00.000Z",
    );
    // The foreign key reads as a link to the customer, by its name.
    expect(largest?.customer_id).toEqual([{ id: "1", label: "Ada" }]);
    expect(largest?.ag_seq).toBeNull();

    const searched = await readPage(
      db,
      engine,
      { search: "draft", limit: 10, timeZone: "UTC" },
      { total: false },
    );
    expect(searched.rows.map((row) => row.id)).toEqual(["1003"]);

    // The other side lists the invoices that point to it.
    const customers = await loadEngine(db, tableIds[0] ?? "", () => true);
    const people = await readPage(
      db,
      customers.engine,
      { limit: 10, timeZone: "UTC" },
      { total: false },
    );
    expect(people.rows.map((row) => row.name)).toEqual(["Ada", "Bob"]);
    expect(people.rows[0]?.invoices).toEqual([
      { id: "1001", label: "1001" },
      { id: "1002", label: "1002" },
    ]);

    // Comments on a client's row live here, under its key (ADR 0006).
    await addComment(db, {
      tableId: invoicesId,
      rowId: "1002",
      authorId: admin,
      body: "Too large?",
    });
    expect(await countComments(db, invoicesId, ["1002", "1003"])).toEqual({
      "1002": 1,
    });

    // A formula computes in the client's database, from its columns.
    await addColumn(db, admin, invoicesId, {
      label: "Double",
      fieldType: "formula",
      formulaSource: "{amount} * 2",
    });
    const computed = await readPage(
      db,
      (await loadEngine(db, invoicesId, () => true)).engine,
      { rowIds: ["1003"], limit: 1, timeZone: "UTC" },
      { total: false },
    );
    // A computed number reads canonical, the same on every engine.
    expect(computed.rows[0]?.double).toBe("14.5");
    // Text read as dates needs no function of AnyGridDB's on the client.
    await addColumn(db, admin, invoicesId, {
      label: "Text dates",
      fieldType: "formula",
      formulaSource:
        'DATETIME_DIFF("2026-03-01", "2026-02-28", "days") & "|" & YEAR("2026-02-30") & "|" & DATETIME_DIFF("2026-01-10T10:00:00Z", "2026-01-10 09:30", "minutes") & "|" & DATETIME_DIFF("2026-01-10T09:59:00+02:00", "2026-01-10 09:00", "minutes") & "|" & DATETIME_DIFF("2026-01-10T12:00+0530", "2026-01-10T06:30Z", "minutes")',
    });
    const dated = await readPage(
      db,
      (await loadEngine(db, invoicesId, () => true)).engine,
      { rowIds: ["1003"], limit: 1, timeZone: "Europe/Paris" },
      { total: false },
    );
    expect(dated.rows[0]?.text_dates).toBe("1||90|-1|0");

    // Without a side schema, a field that stores something is kept in
    // AnyGridDB's database (ADR 0046); one no table can keep is refused.
    const note = await addColumn(db, admin, invoicesId, {
      label: "Note",
      fieldType: "text",
    });
    await expect(
      addColumn(db, admin, invoicesId, {
        label: "Files",
        fieldType: "attachment",
      }),
    ).rejects.toThrow("External table schema is the client's");
    const table = await db
      .selectFrom("dataTables")
      .selectAll()
      .where("id", "=", invoicesId)
      .executeTakeFirstOrThrow();
    const scope = await loadRowScope(
      db,
      {
        userId: admin,
        bindings: [{ role: "owner", scope: "base", scopeId: base.id }],
      },
      table,
    );
    await expect(
      updateRows(
        {
          db,
          bus: { publish: () => Promise.resolve() } as never,
          log: () => undefined,
        },
        scope,
        [{ rowId: "1003", values: { amount: "8" } }],
        { source: "web" },
      ),
    ).rejects.toThrow("External table is read-only");
    // Its own fields are written even so, and read back where they live.
    const services = {
      db,
      bus: { publish: () => Promise.resolve() } as never,
      log: () => undefined,
    };
    await updateRows(
      services,
      scope,
      [{ rowId: "1003", values: { [note.name]: "Paid" } }],
      { source: "web" },
    );
    const invoices = (await loadEngine(db, invoicesId, () => true)).engine;
    const noted = await readPage(
      db,
      invoices,
      {
        limit: 10,
        timeZone: "UTC",
        filter: {
          conjunction: "and",
          conditions: [{ column: note.name, op: "is", value: "paid" }],
        },
      },
      { total: true },
    );
    expect(noted.rows.map((row) => [row.id, row[note.name]])).toEqual([
      ["1003", "Paid"],
    ]);
    expect(noted.total).toBe(1);
    // A field rule that hides it hides its value too.
    const hidden = await readPage(
      db,
      {
        ...invoices,
        access: {
          hidden: (_table, name) => name === note.name,
          readOnly: () => false,
          rowFilter: () => undefined,
        },
      },
      { rowIds: ["1003"], limit: 1, timeZone: "UTC" },
      { total: false },
    );
    expect(hidden.rows[0]?.[note.name] ?? null).toBeNull();
    // Only a view's own filter reads it: elsewhere it is refused, not empty.
    await expect(
      readPage(
        db,
        invoices,
        {
          limit: 10,
          timeZone: "UTC",
          sort: [{ column: note.name, direction: "asc" }],
        },
        { total: false },
      ),
    ).rejects.toMatchObject({ code: "control_plane_sort" });
    expect(() =>
      buildReadRows(invoices, {
        limit: 1,
        filter: {
          conjunction: "and",
          conditions: [{ column: note.name, op: "is_empty" }],
        },
      }),
    ).toThrow(expect.objectContaining({ code: "control_plane_filter" }));
    // A source with exposed tables stays.
    await expect(deleteSource(deps, admin, source.id)).rejects.toThrow(
      "Source in use",
    );
    // Removing them forgets them, and changes nothing at the client's.
    const files = { delete: () => Promise.resolve() } as never;
    await removeTable(db, files, admin, invoicesId, () => undefined);
    await removeTable(db, files, admin, tableIds[0] ?? "", () => undefined);
    const still = await server?.exec([
      "psql",
      "-U",
      "postgres",
      "-d",
      "erp",
      "-tAc",
      "select count(*) from invoices",
    ]);
    expect(still?.output.trim()).toBe("3");
    await deleteSource(deps, admin, source.id);
  });

  it("estimates a large client table's total, and counts it on demand", async () => {
    const deps = { db, key, settings };
    pools ??= new SourcePools({ db, key, settings, log: () => undefined });
    setSourcePools(pools);
    const source = await createSource(deps, admin, {
      name: "Events",
      ...connection(),
      connectionLimit: 2,
    });
    const base = await insertBase(db, admin, { name: "Events" });
    const {
      tableIds: [eventsId = ""],
    } = await exposeTables(deps, admin, {
      sourceId: source.id,
      baseId: base.id,
      tables: [{ schema: "public", name: "events" }],
    });
    const { engine } = await loadEngine(db, eventsId, () => true);
    const spec = { limit: 100, timeZone: "UTC" };
    // Read whole, the table shows its engine's estimate (ANALYZE ran).
    const whole = await readPage(db, engine, spec, { total: true });
    expect(whole).toMatchObject({ total: 20_000, totalEstimated: true });
    expect(whole.rows).toHaveLength(100);
    // On demand, an exact count.
    const exact = await readPage(db, engine, spec, {
      total: true,
      exact: true,
    });
    expect(exact).toMatchObject({ total: 20_000, totalEstimated: false });
    // Filtered, the count is exact.
    const odd = await readPage(
      db,
      engine,
      {
        ...spec,
        filter: {
          conjunction: "and",
          conditions: [{ column: "kind", op: "is", value: "odd" }],
        },
      },
      { total: true },
    );
    expect(odd).toMatchObject({ total: 10_000, totalEstimated: false });
    // A later page reads without its count.
    const later = await readPage(
      db,
      engine,
      { ...spec, offset: 100 },
      { total: false },
    );
    expect(later).toMatchObject({ total: null, totalEstimated: false });
  });

  it("follows a table its DBA changed: new columns, a list of values, a dropped column", async () => {
    const deps = { db, key, settings };
    pools ??= new SourcePools({ db, key, settings, log: () => undefined });
    setSourcePools(pools);
    const dba = (statement: string) =>
      server?.exec(["psql", "-U", "postgres", "-d", "erp", "-c", statement]);
    await dba(
      "create table tickets (id serial primary key, title text not null, state text); insert into tickets (title, state) values ('Printer', 'open'); grant select on tickets to anygriddb",
    );
    const source = await createSource(deps, admin, {
      name: "Tickets",
      ...connection(),
      connectionLimit: 2,
    });
    const base = await insertBase(db, admin, { name: "Tickets" });
    const {
      tableIds: [ticketsId = ""],
    } = await exposeTables(deps, admin, {
      sourceId: source.id,
      baseId: base.id,
      tables: [{ schema: "public", name: "tickets" }],
    });
    // The DBA lists the states, adds a column, and drops one.
    await dba(
      "alter table tickets add constraint tickets_state check (state in ('open', 'closed')); alter table tickets add column assignee varchar(50); alter table tickets drop column title",
    );
    const before = (await loadEngine(db, ticketsId, () => true)).engine;
    await expect(
      readPage(db, before, { limit: 10, timeZone: "UTC" }, { total: false }),
    ).rejects.toMatchObject({ code: "source_schema_changed" });
    const beforePrimary = before.table.primaryColumn;
    expect(beforePrimary).toBe("title");
    const result = await refreshExposedTable(deps, admin, ticketsId);
    expect(result).toMatchObject({
      added: ["assignee"],
      changed: ["state"],
      removed: ["title"],
    });
    const after = (await loadEngine(db, ticketsId, () => true)).engine;
    const state = after.table.columns.find((column) => column.name === "state");
    expect(state?.fieldType).toBe("single_select");
    // Dropping the naming primary re-elects another client field (the key).
    expect(after.table.primaryColumn).toBeTruthy();
    expect(after.table.primaryColumn).not.toBe("title");
    const page = await readPage(
      db,
      after,
      { limit: 10, timeZone: "UTC" },
      { total: false },
    );
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ state: "open", assignee: null });
    // Nothing moved since: a second refresh changes nothing.
    expect(await refreshExposedTable(deps, admin, ticketsId)).toMatchObject({
      added: [],
      changed: [],
      removed: [],
    });
  });

  it("does not elect a boolean as the primary field on expose", async () => {
    const deps = { db, key, settings };
    pools ??= new SourcePools({ db, key, settings, log: () => undefined });
    setSourcePools(pools);
    const dba = (statement: string) =>
      server?.exec(["psql", "-U", "postgres", "-d", "erp", "-c", statement]);
    await dba(
      "create table flags (a boolean not null, b boolean not null, primary key (a, b)); grant select on flags to anygriddb",
    );
    const source = await createSource(deps, admin, {
      name: "Flags",
      ...connection(),
      connectionLimit: 2,
    });
    const base = await insertBase(db, admin, { name: "Flags" });
    const {
      tableIds: [flagsId = ""],
    } = await exposeTables(deps, admin, {
      sourceId: source.id,
      baseId: base.id,
      tables: [{ schema: "public", name: "flags" }],
    });
    const engine = (await loadEngine(db, flagsId, () => true)).engine;
    expect(engine.table.primaryColumn).toBeUndefined();
  });

  it("saves a source only once it connects, and never sends its password back", async () => {
    const deps = { db, key, settings };
    const input = {
      name: "ERP",
      ...connection(),
      connectionLimit: 5,
    };
    const created = await createSource(deps, admin, input);
    expect(created).toMatchObject({ name: "ERP", host: "localhost" });
    expect(created).not.toHaveProperty("password");
    expect(created).not.toHaveProperty("passwordCiphertext");
    await expect(createSource(deps, admin, input)).rejects.toThrow(
      "Source already exists",
    );
    await expect(
      createSource(deps, admin, { ...input, name: "Bad", password: "wrong" }),
    ).rejects.toThrow("Source sign-in failed");

    // A change without a password keeps the stored one, and checks again.
    const renamed = await updateSource(deps, admin, {
      id: created.id,
      name: "ERP prod",
    });
    expect(renamed.name).toBe("ERP prod");
    expect(renamed.passwordChangedAt).toEqual(created.passwordChangedAt);
    const names = (await listSources(db)).map((source) => source.name);
    expect(names).toContain("ERP prod");
    expect(names).not.toContain("ERP");
    expect(names).not.toContain("Bad");

    // A read replica without a password of its own uses the primary's, the
    // next one included (the same server stands in for the replica here).
    const replicated = await updateSource(deps, admin, {
      id: created.id,
      replicaHost: "localhost",
      replicaPort: port,
    });
    expect(replicated).toMatchObject({
      replicaHost: "localhost",
      replicaServerVersion: expect.any(String),
    });
    const replicaSecret = async () =>
      (
        await db
          .selectFrom("sources")
          .select("replicaPasswordCiphertext")
          .where("id", "=", created.id)
          .executeTakeFirstOrThrow()
      ).replicaPasswordCiphertext;
    expect(await replicaSecret()).toBeNull();
    const rotate = (password: string) =>
      server?.exec([
        "psql",
        "-U",
        "postgres",
        "-d",
        "erp",
        "-c",
        `alter role anygriddb password '${password}'`,
      ]);
    await rotate("rotated-pass");
    try {
      await updateSource(deps, admin, {
        id: created.id,
        password: "rotated-pass",
      });
      expect(await recheckSource(deps, created.id)).toMatchObject({
        replicaServerVersion: expect.any(String),
      });
      expect(await replicaSecret()).toBeNull();
    } finally {
      await rotate("readerpass");
    }
    await updateSource(deps, admin, { id: created.id, password: "readerpass" });

    // The audit trail records the change, never the encrypted password.
    const events = await db
      .selectFrom("auditEvents")
      .select(["oldValue", "newValue"])
      .where("userId", "=", admin)
      .execute();
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(events)).not.toMatch(
      /password_ciphertext|password_nonce/,
    );

    await deleteSource(deps, admin, created.id);
    expect((await listSources(db)).map((source) => source.id)).not.toContain(
      created.id,
    );
  });

  it("names a client table's database to its readers, never its address", async () => {
    const deps = { db, key, settings };
    const source = await createSource(deps, admin, {
      name: "Ledger",
      ...connection(),
      connectionLimit: 1,
    });
    const base = await insertBase(db, admin, { name: "Ledger book" });
    await exposeTables(deps, admin, {
      sourceId: source.id,
      baseId: base.id,
      tables: [{ schema: "public", name: "customers" }],
    });
    const env = {
      AUTH_ENCRYPTION_KEY: key,
      PUBLIC_URL: "https://grid.example.org",
    } as unknown as Env;
    const reader = browserFactory({
      db: () => db,
      env,
      hub: {
        closeUser: vi.fn(() => 0),
        closeAllBut: vi.fn(() => 0),
        closeSession: vi.fn(() => 0),
      },
    })();
    const email = `reader-${randomBytes(4).toString("hex")}@example.org`;
    await reader.call().auth.signup({
      email,
      displayName: "Rita Reader",
      password: "correct horse battery staple",
    });
    // No role yet: neither the base nor the database it reads.
    expect(JSON.stringify(await reader.call().catalog.list())).not.toContain(
      "Ledger",
    );
    await grantMember(db, admin, { baseId: base.id, email, role: "viewer" });
    const listed = await reader.call().catalog.list();
    const external = listed.find((item) => item.id === base.id)?.tables[0]
      ?.external;
    expect(external?.source).toEqual({ id: source.id, name: "Ledger" });
    expect(external).not.toHaveProperty("host");
    expect(external).not.toHaveProperty("username");
    expect(JSON.stringify(listed)).not.toContain("readerpass");
  });
});
