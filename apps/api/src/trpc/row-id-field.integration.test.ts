/**
 * A field that shows the row's own id (ADR 0063): the id the API, webhooks
 * and links name the row by, read, filtered and sorted like text, and never
 * written.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
} from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");

describe("a row id field", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: randomBytes(32),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const owner = browser();
  let tableId = "";
  let field = "";
  let ids: string[] = [];

  beforeAll(async () => {
    const created = await createTestDatabase("row-id-field");
    db = created.db;
    close = created.close;
    await owner.call().auth.signup({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: "correct horse battery staple",
    });
    await enrollTotp(owner);
    const baseId = (await owner.call().catalog.createBase({ name: "Lab" })).id;
    tableId = (
      await owner.call().catalog.createTable({
        baseId,
        name: "Samples",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    field = (
      await owner.call().catalog.addColumn({
        tableId,
        label: "Ref",
        fieldType: "row_id",
      })
    ).name;
    ids = (
      await owner.call().rows.insertMany({
        tableId,
        rows: [{ title: "A" }, { title: "B" }],
      })
    ).ids;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("shows each row's own id, and finds a row by it", async () => {
    const all = await owner.call().rows.read({
      tableId,
      filter: {
        conjunction: "or",
        conditions: ids.map((id) => ({ column: field, op: "is", value: id })),
      },
      sort: [{ column: field, direction: "asc" }],
    });
    expect(all.rows.map((row) => [row.id, row[field]])).toEqual(
      [...ids].sort().map((id) => [id, id]),
    );
    const one = await owner.call().rows.read({
      tableId,
      filter: {
        conjunction: "and",
        conditions: [{ column: field, op: "is", value: ids[1] }],
      },
    });
    expect(one.rows.map((row) => row.id)).toEqual([ids[1]]);
  });

  it("is never written, by a row's change or by a new row", async () => {
    const rowId = ids[0] ?? "";
    expect(
      await errorCode(
        owner.call().rows.update({
          tableId,
          rowId,
          values: { [field]: "00000000-0000-4000-8000-000000000000" },
        }),
      ),
    ).toBe("unknown_column");
    expect(
      await errorCode(
        owner.call().rows.insertMany({
          tableId,
          rows: [{ title: "C", [field]: "x" }],
        }),
      ),
    ).toBe("unknown_column");
  });
});
