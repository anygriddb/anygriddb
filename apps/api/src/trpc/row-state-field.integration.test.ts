/**
 * A field of a row's state (ADR 0133), against a real database: it reads
 * the state the database keeps, filters and groups by its key, sorts in
 * the table's circuit's order, follows a step, and takes no write.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
} from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");

describe("a field of the row's state", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const owner = browserFactory({ db: () => db, env, hub })();
  let tableId = "";
  const rowIds: Record<string, string> = {};

  beforeAll(async () => {
    const created = await createTestDatabase("row_state_field");
    db = created.db;
    close = created.close;
    await owner.signUpFirst({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: "correct horse battery staple",
    });
    await enrollTotp(owner);
    const baseId = (await owner.call().catalog.createBase({ name: "Ledger" }))
      .id;
    tableId = (
      await owner.call().catalog.createTable({
        baseId,
        name: "Samples",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    await owner.call().catalog.addColumn({
      tableId,
      name: "state",
      label: "State",
      fieldType: "row_state",
    });
    for (const title of ["kept", "sent", "also kept"]) {
      rowIds[title] = (
        await owner.call().rows.insert({ tableId, values: { title } })
      ).id;
    }
    await owner.call().rows.transition({
      tableId,
      rowId: rowIds.sent ?? "",
      transitionKey: "submit",
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  const read = (input: Record<string, unknown>) =>
    owner.call().rows.read({ tableId, fields: ["title", "state"], ...input });

  it("reads each row's state, and follows a step", async () => {
    const { rows } = await read({
      sort: [{ column: "title", direction: "asc" }],
    });
    expect(rows.map((row) => [row.title, row.state])).toEqual([
      ["also kept", "draft"],
      ["kept", "draft"],
      ["sent", "submitted"],
    ]);
  });

  it("filters by a state's key, and sorts and groups in the circuit's order", async () => {
    const chosen = await read({
      filter: {
        conjunction: "and",
        conditions: [{ column: "state", op: "is", value: "submitted" }],
      },
    });
    expect(chosen.rows.map((row) => row.title)).toEqual(["sent"]);
    // The compliance circuit: draft, submitted, locked, signed.
    const sorted = await read({
      sort: [
        { column: "state", direction: "desc" },
        { column: "title", direction: "asc" },
      ],
    });
    expect(sorted.rows.map((row) => row.title)).toEqual([
      "sent",
      "also kept",
      "kept",
    ]);
    const grouped = await read({
      groupBy: [{ column: "state", direction: "asc" }],
    });
    expect(grouped.groups.map((group) => [group.keys[0], group.count])).toEqual(
      [
        ["draft", 2],
        ["submitted", 1],
      ],
    );
  });

  it("takes no write: a state changes by a step only", async () => {
    // As a created time: a field the system keeps is none a write names.
    expect(
      await errorCode(
        owner.call().rows.updateMany({
          tableId,
          updates: [{ rowId: rowIds.kept ?? "", values: { state: "signed" } }],
        }),
      ),
    ).toBe("unknown_column");
    const { rows } = await read({
      filter: {
        conjunction: "and",
        conditions: [{ column: "title", op: "is", value: "kept" }],
      },
    });
    expect(rows[0]?.state).toBe("draft");
  });
});
