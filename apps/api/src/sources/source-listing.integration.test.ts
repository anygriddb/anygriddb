/**
 * A source with more tables than one look returns: the list says it was
 * cut and a search reaches the rest, and what asks for one table by its
 * name never depends on where the cut fell.
 */
import { giveInstanceRole } from "../auth/instance-roles.test-helpers.js";
import { randomBytes } from "node:crypto";
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import { insertBase } from "../data/schema-ops.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import { exposeTables, refreshExposedTable, setTableWrites } from "./expose.js";
import { setSourcePools, SourcePools } from "./pools.js";
import {
  createSource,
  listSourceTables,
  namedSourceTables,
} from "./sources.js";
import type { SourceSettings } from "./types.js";
import { runWatch, setTableWatch } from "./watch.js";

const settings: SourceSettings = {
  allows: () => true,
  allowedHosts: [],
  allowPlaintext: true,
};

describe("a source of more than 2,000 tables", () => {
  const key = keyRing(randomBytes(32));
  const client = `listing_${randomBytes(4).toString("hex")}`;
  const reader = `reader_${randomBytes(4).toString("hex")}`;
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let pools: SourcePools | undefined;
  let admin: pg.Client;
  let erp: pg.Client;
  let actor = "";
  let baseId = "";
  let sourceId = "";
  const deps = () => ({ db, key, settings });

  beforeAll(async () => {
    const adminUrl = inject("adminUrl");
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${client}`);
    await admin.query(`create role ${reader} login password 'readerpass'`);
    const url = new URL(adminUrl);
    url.pathname = `/${client}`;
    erp = new pg.Client({ connectionString: url.toString() });
    await erp.connect();
    // 2,000 tables that sort before the ones a test adds past the cut.
    await erp.query(`
      do $$ begin
        for i in 1..2000 loop
          execute format('create table %I (id int primary key)', 'a' || lpad(i::text, 4, '0'));
        end loop;
      end $$;
      grant select on all tables in schema public to ${reader};
    `);
    const control = await createTestDatabase("listing");
    db = control.db;
    close = control.close;
    actor = (
      await db
        .insertInto("users")
        .values({
          email: "admin@example.com",
          displayName: "Admin",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await giveInstanceRole(db, actor, "administrator");
    baseId = (await insertBase(db, actor, { name: "Listing" })).id;
    pools = new SourcePools({ db, key, settings, log: () => undefined });
    setSourcePools(pools);
    sourceId = (
      await createSource(deps(), actor, {
        name: "Many tables",
        engine: "postgres",
        host: url.hostname,
        port: Number(url.port),
        database: client,
        username: reader,
        password: "readerpass",
        tlsCa: null,
        allowPlaintext: true,
        connectionLimit: 2,
        queryTimeoutMs: 15_000,
        timeZone: "UTC",
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    setSourcePools(undefined);
    await pools?.close();
    await close?.();
    await erp.end();
    await admin.query(`drop database if exists ${client} with (force)`);
    await admin.query(`drop role if exists ${reader}`);
    await admin.end();
  });

  it("says nothing was left out at exactly 2,000", async () => {
    const listing = await listSourceTables(deps(), sourceId);
    expect(listing.tables).toHaveLength(2_000);
    expect(listing.truncated).toBe(false);
  });

  it("says the list was cut at 2,001, and reaches the rest by name", async () => {
    await erp.query(`
      create table zz_target (id int primary key, name text);
      create table zz_past (
        id int primary key,
        target_id int references zz_target (id),
        changed timestamptz not null default clock_timestamp()
      );
      grant select on zz_target, zz_past to ${reader};
      grant update on zz_past to ${reader};
    `);
    const listing = await listSourceTables(deps(), sourceId);
    expect(listing.tables).toHaveLength(2_000);
    expect(listing.truncated).toBe(true);
    expect(listing.tables.map((table) => table.name)).not.toContain("zz_past");
    const found = await listSourceTables(deps(), sourceId, {
      scope: { search: "ZZ_PA" },
    });
    expect(found.tables.map((table) => table.name)).toEqual(["zz_past"]);
    expect(found.truncated).toBe(false);
    expect(
      (
        await namedSourceTables(deps(), sourceId, [
          { schema: "public", name: "zz_past" },
          { schema: "public", name: "gone" },
          { schema: "other", name: "zz_past" },
        ])
      ).map((table) => table.name),
    ).toEqual(["zz_past"]);
  });

  it("takes a search as text, whatever it holds", async () => {
    for (const search of ["%", "'; drop table a0001; --", "\\"]) {
      const found = await listSourceTables(deps(), sourceId, {
        scope: { search },
      });
      expect(found.tables, search).toEqual([]);
    }
    // `_` is the character, not a wildcard: a0001 holds none.
    const underscore = await listSourceTables(deps(), sourceId, {
      scope: { search: "_" },
    });
    expect(underscore.tables.map((table) => table.name)).toEqual([
      "zz_past",
      "zz_target",
    ]);
    expect(
      (await erp.query(`select to_regclass('public.a0001') as t`)).rows[0]?.t,
    ).toBe("a0001");
  });

  it("exposes, opens to writes, follows and watches a table past the cut", async () => {
    const { tableIds } = await exposeTables(deps(), actor, {
      sourceId,
      baseId,
      tables: [
        { schema: "public", name: "zz_target" },
        { schema: "public", name: "zz_past" },
      ],
    });
    expect(tableIds).toHaveLength(2);
    const pastId = tableIds[1] ?? "";
    const link = await db
      .selectFrom("dataColumns")
      .select(["fieldType"])
      .where("tableId", "=", pastId)
      .where("physicalName", "=", "target_id")
      .executeTakeFirstOrThrow();
    expect(link.fieldType).toBe("relation_one_to_many");
    await expect(
      setTableWrites(deps(), actor, {
        tableId: pastId,
        update: true,
        insert: false,
        delete: false,
      }),
    ).resolves.toMatchObject({ update: true });
    await erp.query(`alter table zz_past add column note text`);
    await erp.query(`grant select on zz_past to ${reader}`);
    const refreshed = await refreshExposedTable(deps(), actor, pastId);
    expect(refreshed.added).toEqual(["note"]);
    await setTableWatch(deps(), actor, {
      tableId: pastId,
      method: "column",
      column: "changed",
      intervalSeconds: 5,
    });
    const { bus } = recordingBus();
    expect(await runWatch({ db, bus, log: () => undefined }, pastId)).toBe(5);
  });

  it("still says a table that is really gone has changed", async () => {
    const { tableIds } = await exposeTables(deps(), actor, {
      sourceId,
      baseId,
      tables: [{ schema: "public", name: "a0001" }],
    });
    const tableId = tableIds[0] ?? "";
    await erp.query(`drop table a0001`);
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => "ok",
        (error: unknown) =>
          error instanceof AppError ? error.code : String(error),
      );
    expect(await code(refreshExposedTable(deps(), actor, tableId))).toBe(
      "source_schema_changed",
    );
    expect(
      await code(
        setTableWrites(deps(), actor, {
          tableId,
          update: false,
          insert: false,
          delete: false,
        }),
      ),
    ).toBe("source_schema_changed");
    expect(
      await code(
        setTableWatch(deps(), actor, {
          tableId,
          method: "column",
          column: "id",
          intervalSeconds: 5,
        }),
      ),
    ).toBe("source_schema_changed");
    expect(
      await code(
        exposeTables(deps(), actor, {
          sourceId,
          baseId,
          tables: [{ schema: "public", name: "never_there" }],
        }),
      ),
    ).toBe("unknown_table");
  });
});
