/**
 * An Airtable base imported for real, against a stand-in for Airtable's
 * Web API: the job unseals its token, reads every page, builds the base
 * through the snapshot import, and drops the token from its input.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptSecret } from "../auth/crypto.js";
import { DiskStore } from "../files/index.js";
import { jobRunners } from "../job-runners.js";
import { createTestDatabase } from "../test-database.js";
import { loadEngine } from "./engine.js";
import { readPage } from "./rows.js";

const meta = {
  tables: [
    {
      id: "tblClients",
      name: "Clients",
      primaryFieldId: "fld1",
      fields: [
        { id: "fld1", name: "Name", type: "singleLineText" },
        {
          id: "fld2",
          name: "Tier",
          type: "singleSelect",
          options: { choices: [{ name: "Gold", color: "yellowLight2" }] },
        },
        {
          id: "fld3",
          name: "Orders",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblOrders", inverseLinkFieldId: "fld12" },
        },
        {
          id: "fld4",
          name: "Order count",
          type: "count",
          options: { recordLinkFieldId: "fld3" },
        },
      ],
      views: [{ id: "viw1", name: "Grid view", type: "grid" }],
    },
    {
      id: "tblOrders",
      name: "Orders",
      primaryFieldId: "fld10",
      fields: [
        { id: "fld10", name: "Ref", type: "singleLineText" },
        {
          id: "fld11",
          name: "Amount",
          type: "currency",
          options: { symbol: "€", precision: 2 },
        },
        {
          id: "fld12",
          name: "Client",
          type: "multipleRecordLinks",
          options: {
            linkedTableId: "tblClients",
            inverseLinkFieldId: "fld3",
            prefersSingleRecordLink: true,
          },
        },
        {
          id: "fld13",
          name: "Client tier",
          type: "multipleLookupValues",
          options: { recordLinkFieldId: "fld12", fieldIdInLinkedTable: "fld2" },
        },
        {
          id: "fld14",
          name: "With tax",
          type: "formula",
          options: { formula: "{fld11} * 1.2" },
        },
      ],
      views: [{ id: "viw2", name: "All orders", type: "grid" }],
    },
  ],
};

const pages: Record<string, unknown[]> = {
  tblClients: [
    {
      records: [
        {
          id: "recC1",
          fields: { fld1: "Acme", fld2: "Gold", fld3: ["recO1", "recO2"] },
        },
      ],
      offset: "next",
    },
    { records: [{ id: "recC2", fields: { fld1: "Beta" } }] },
  ],
  tblOrders: [
    {
      records: [
        { id: "recO1", fields: { fld10: "O-1", fld11: 100, fld12: ["recC1"] } },
        {
          id: "recO2",
          fields: { fld10: "O-2", fld11: 20.5, fld12: ["recC1"] },
        },
      ],
    },
  ],
};

const fakeAirtable = (seen: string[]) =>
  ((url: string, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    const path = new URL(url).pathname;
    if (path.endsWith("/tables")) {
      return Promise.resolve(Response.json(meta));
    }
    const table = path.split("/").at(-1) ?? "";
    const page = new URL(url).searchParams.get("offset") ? 1 : 0;
    return Promise.resolve(
      Response.json(pages[table]?.[page] ?? { records: [] }),
    );
  }) as typeof fetch;

describe("an Airtable base imported", () => {
  let db: Database;
  let close: () => Promise<void>;
  let userId = "";
  const key = randomBytes(32);

  beforeAll(async () => {
    const created = await createTestDatabase("airtable");
    db = created.db;
    close = created.close;
    userId = (
      await db
        .insertInto("users")
        .values({
          email: `at-${randomBytes(4).toString("hex")}@example.com`,
          displayName: "Importer",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  });

  afterAll(async () => {
    await close();
  });

  it("builds tables, links, lookups, formulas, and rows, then forgets the token", async () => {
    const token = "pat" + "test".repeat(8);
    const sealed = encryptSecret(token, key);
    const job = await db
      .insertInto("jobs")
      .values({
        kind: "import_airtable",
        userId,
        status: "running",
        input: JSON.stringify({
          airtableBaseId: "app" + "A".repeat(14),
          name: "Ventes",
          token: {
            ciphertext: sealed.ciphertext.toString("base64"),
            nonce: sealed.nonce.toString("base64"),
          },
        }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const seen: string[] = [];
    const progress: Array<[number, number | null]> = [];
    const files = new DiskStore(await mkdtemp(join(tmpdir(), "airtable-")));
    const runners = jobRunners({
      db,
      bus: { publish: () => Promise.resolve() } as never,
      files,
      log: () => undefined,
      key,
      airtableFetch: fakeAirtable(seen),
    });
    const outcome = await runners.import_airtable({
      job,
      progress: (done, total) => {
        progress.push([done, total ?? null]);
        return Promise.resolve();
      },
    });
    // The bar only moves forward, on one scale for both phases.
    for (const [index, [done, total]] of progress.entries()) {
      expect(total).toBe(1_000);
      expect(done).toBeGreaterThanOrEqual(progress[index - 1]?.[0] ?? 0);
    }
    expect(progress.at(-1)?.[0]).toBe(1_000);
    expect(seen.length).toBe(4);
    expect(seen.every((header) => header === `Bearer ${token}`)).toBe(true);
    const result = outcome.result as {
      baseId: string;
      tables: number;
      rows: number;
      report: unknown[];
    };
    expect(result).toMatchObject({ tables: 2, rows: 4 });

    const tables = await db
      .selectFrom("dataTables")
      .select(["id", "name"])
      .where("baseId", "=", result.baseId)
      .orderBy("position")
      .execute();
    expect(tables.map((table) => table.name)).toEqual(["Clients", "Orders"]);
    const clients = tables[0]?.id ?? "";
    const orders = tables[1]?.id ?? "";
    const read = async (tableId: string) => {
      const { engine } = await loadEngine(db, tableId, () => true);
      const page = await readPage(
        db,
        engine,
        { limit: 10, timeZone: "UTC" },
        { total: false },
      );
      const label = new Map(
        engine.table.columns.map((column) => [column.name, column.label]),
      );
      return page.rows.map((row) =>
        Object.fromEntries(
          Object.entries(row)
            .filter(([name]) => label.has(name))
            .map(([name, value]) => [label.get(name), value]),
        ),
      );
    };
    const clientRows = await read(clients);
    expect(clientRows[0]).toMatchObject({
      Name: "Acme",
      Tier: "Gold",
      "Order count": "2",
    });
    expect(
      (clientRows[0]?.Orders as Array<{ label: string }>).map(
        (link) => link.label,
      ),
    ).toEqual(["O-1", "O-2"]);
    const orderRows = await read(orders);
    expect(orderRows[0]).toMatchObject({
      Ref: "O-1",
      Amount: "100",
      "Client tier": ["Gold"],
      "With tax": "120",
    });
    expect(orderRows[1]).toMatchObject({ Ref: "O-2", "With tax": "24.6" });

    // The token went with the job's work.
    const stored = await db
      .selectFrom("jobs")
      .select("input")
      .where("id", "=", job.id)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(stored.input)).not.toContain("ciphertext");
    expect(stored.input).toMatchObject({ airtableBaseId: "app" + "A".repeat(14) });
  });
});
