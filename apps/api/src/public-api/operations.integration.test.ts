/**
 * What the public API says of a base's tables (the REST list and the
 * OpenAPI document), against a real database: each table reads as a read
 * of that table alone would describe it, for an owner and for a member
 * under field rules, and the catalog is read once, however many tables
 * the base has.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadBindings } from "../auth/access.js";
import { readerEngine, setTableAcl } from "../data/acl.js";
import { withAudit } from "../data/audit-context.js";
import { insertComputed } from "../data/computed.js";
import { addRelation } from "../data/relations.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { createTestDatabase } from "../test-database.js";
import { publicColumns } from "../trpc/catalog-router.js";
import { listTables, openApiDocument } from "./operations.js";
import type { Actor, PublicApiDeps } from "./types.js";

const suffix = randomBytes(6).toString("hex");
const always = () => true;

describe("a base's tables, as the public API describes them", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let deps: PublicApiDeps;
  let owner = "";
  let editor = "";
  let baseId = "";
  const tables: Record<string, string> = {};

  async function actor(userId: string): Promise<Actor> {
    return {
      user: {
        id: userId,
        email: `${userId}@example.org`,
        displayName: "Someone",
        isAdmin: false,
        isSupport: false,
        isAuditor: false,
      },
      bindings: await loadBindings(db, userId),
    };
  }

  /** What a read of each table alone says of its fields. */
  async function oneByOne(who: Actor) {
    const out: Record<string, unknown> = {};
    for (const [name, tableId] of Object.entries(tables)) {
      const { engine, rows } = await readerEngine(db, tableId, {
        userId: who.user.id,
        bindings: who.bindings,
      });
      out[name] = publicColumns(engine, rows).map((column) => ({
        name: column.name,
        type: column.fieldType,
        kind: column.kind,
        config: column.config,
      }));
    }
    return out;
  }

  /** The same, from the list of the base's tables. */
  async function listed(who: Actor) {
    const { tables: list } = await listTables(deps, who, baseId);
    return Object.fromEntries(
      list.map((table) => [
        table.name,
        table.fields.map((field) => ({
          name: field.name,
          type: field.type,
          kind: field.kind,
          config: field.config,
        })),
      ]),
    );
  }

  /** How many statements a call sends. */
  async function statements(call: () => Promise<unknown>): Promise<number> {
    const sent = vi.spyOn(pg.Client.prototype, "query");
    try {
      await call();
      return sent.mock.calls.length;
    } finally {
      sent.mockRestore();
    }
  }

  async function table(name: string): Promise<string> {
    const id = (
      await insertTable(db, owner, {
        baseId,
        name,
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    tables[name] = id;
    return id;
  }

  beforeAll(async () => {
    const created = await createTestDatabase("public_api");
    db = created.db;
    close = created.close;
    deps = {
      db,
      bus: { publish: () => Promise.resolve() } as never,
      publicUrl: "https://grid.example.org",
      log: () => undefined,
    };
    const people = await db
      .insertInto("users")
      .values([
        { email: `owner-${suffix}@example.org`, displayName: "Owner" },
        { email: `editor-${suffix}@example.org`, displayName: "Editor" },
      ])
      .returning("id")
      .execute();
    owner = people[0]?.id ?? "";
    editor = people[1]?.id ?? "";
    baseId = (await insertBase(db, owner, { name: "Atlas" })).id;
    await withAudit(db, { userId: owner, source: "web" }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values({
          userId: editor,
          role: "editor",
          scope: "base",
          scopeId: baseId,
        })
        .execute(),
    );

    // Three tables in a chain: a person's city, a city's country. A
    // person reads the country through the city: a lookup of a lookup.
    const countries = await table("Countries");
    const cities = await table("Cities");
    const people2 = await table("People");
    await addRelation(db, owner, {
      tableId: cities,
      name: "country",
      label: "Country",
      kind: "one_to_many",
      targetTableId: countries,
      twoWay: true,
      inverseLabel: "Cities",
    });
    await insertComputed(
      db,
      owner,
      {
        tableId: cities,
        name: "country_name",
        label: "Country name",
        relation: "country",
        target: "name",
      },
      always,
    );
    await addRelation(db, owner, {
      tableId: people2,
      name: "city",
      label: "City",
      kind: "one_to_many",
      targetTableId: cities,
    });
    await insertComputed(
      db,
      owner,
      {
        tableId: people2,
        name: "city_country",
        label: "City's country",
        relation: "city",
        target: "country_name",
      },
      always,
    );
    await addRelation(db, owner, {
      tableId: people2,
      name: "visited",
      label: "Visited",
      kind: "many_to_many",
      targetTableId: countries,
    });
    await insertComputed(
      db,
      owner,
      {
        tableId: people2,
        name: "visits",
        label: "Visits",
        relation: "visited",
        target: "name",
        fn: "count",
      },
      always,
    );
    // The editor does not see a city's country.
    await setTableAcl(db, owner, {
      tableId: cities,
      userId: editor,
      rowFilter: null,
      columns: [
        { column: "name", access: "write" },
        { column: "country", access: "hide" },
        { column: "country_name", access: "hide" },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("describes each table as a read of that table alone does", async () => {
    const who = await actor(owner);
    const fields = await listed(who);
    expect(fields).toEqual(await oneByOne(who));
    expect(
      (fields.People as Array<{ name: string }>).map((field) => field.name),
    ).toEqual(
      expect.arrayContaining(["name", "city", "city_country", "visits"]),
    );
  });

  it("leaves out, for a member under field rules, what those rules hide", async () => {
    const who = await actor(editor);
    const fields = await listed(who);
    expect(fields).toEqual(await oneByOne(who));
    expect(
      (fields.Cities as Array<{ name: string }>).map((field) => field.name),
    ).toEqual(["name"]);
  });

  it("reads the catalog once, however many tables the base has", async () => {
    const who = await actor(owner);
    const list = await statements(() => listTables(deps, who, baseId));
    const document = await statements(() => openApiDocument(deps, who, baseId));
    for (const name of ["Rivers", "Lakes", "Peaks", "Roads"]) {
      await table(name);
    }
    const again = await actor(owner);
    expect(await statements(() => listTables(deps, again, baseId))).toBe(list);
    expect(await statements(() => openApiDocument(deps, again, baseId))).toBe(
      document,
    );
  });
});
