/**
 * A table's status circuit (ADR 0124) through the API: a template applied,
 * rows moved along its transitions by the roles it names, rows of a state
 * it drops moved on the trail, and a sealed row that no change frees.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  joinBase,
  signUpProved,
} from "../trpc/caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("a table's status circuit", () => {
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
  const browser = browserFactory({ db: () => db, env, hub });
  const owner = browser();
  const editor = browser();
  let baseId = "";

  const newTable = async (name: string) =>
    (
      await owner.call().catalog.createTable({
        baseId,
        name,
        columns: [{ name: "ref", label: "Ref", fieldType: "text" }],
      })
    ).id;
  const addRow = async (tableId: string, ref: string) =>
    (await owner.call().rows.insert({ tableId, values: { ref } })).id;
  const statusOf = async (tableId: string, rowId: string) => {
    const table = await db
      .selectFrom("dataTables")
      .select("physicalName")
      .where("id", "=", tableId)
      .executeTakeFirstOrThrow();
    const { rows } = await sql<{ status: string }>`
      select "ag_status" as status from ${sql.table(table.physicalName)}
       where id = ${rowId}
    `.execute(db);
    return rows[0]?.status;
  };

  beforeAll(async () => {
    const created = await createTestDatabase("status_circuits");
    db = created.db;
    close = created.close;
    await owner.signUpFirst({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: PASSWORD,
    });
    await enrollTotp(owner);
    baseId = (await owner.call().catalog.createBase({ name: "Reviews" })).id;
    const editorId = await signUpProved(editor, db, {
      email: `editor-${suffix}@example.org`,
      displayName: "Eddie Editor",
      password: PASSWORD,
    });
    await enrollTotp(editor);
    await joinBase(db, { baseId, userId: editorId, role: "editor" });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("starts on compliance and takes a shipped template", async () => {
    const tableId = await newTable("Letters");
    expect((await owner.call().catalog.getCircuit({ tableId })).key).toBe(
      "compliance",
    );
    const circuit = await owner
      .call()
      .catalog.applyCircuitTemplate({ tableId, templateKey: "simple_review" });
    expect(circuit.key).toBe("simple_review");
    // An editor may not change it.
    expect(
      await errorCode(
        editor
          .call()
          .catalog.applyCircuitTemplate({ tableId, templateKey: "compliance" }),
      ),
    ).toBe("access_denied");
  });

  it("moves a row along the circuit, each step by the roles it names", async () => {
    const tableId = await newTable("Reports");
    await owner
      .call()
      .catalog.applyCircuitTemplate({ tableId, templateKey: "simple_review" });
    const rowId = await addRow(tableId, "R-1");

    await editor
      .call()
      .rows.transition({ tableId, rowId, transitionKey: "submit" });
    expect(await statusOf(tableId, rowId)).toBe("in_review");
    // In review: the row is no longer written, and only an owner approves.
    expect(
      await errorCode(
        editor.call().rows.updateMany({
          tableId,
          updates: [{ rowId, values: { ref: "R-1b" } }],
        }),
      ),
    ).toBe("row_locked");
    expect(
      await errorCode(
        editor
          .call()
          .rows.transition({ tableId, rowId, transitionKey: "approve" }),
      ),
    ).toBe("invalid_status");
    // A transition the circuit has not, from here.
    expect(
      await errorCode(
        owner.call().rows.transition({ tableId, rowId, transitionKey: "sign" }),
      ),
    ).toBe("invalid_status");
    await owner
      .call()
      .rows.transition({ tableId, rowId, transitionKey: "approve" });
    expect(await statusOf(tableId, rowId)).toBe("approved");
  });

  it("moves the rows of a state it drops, each on the trail", async () => {
    const tableId = await newTable("Claims");
    const rowId = await addRow(tableId, "C-1");
    await owner.call().rows.setStatus({ tableId, rowId, status: "submitted" });

    // Submitted is not a state of simple review: it must be said where to.
    expect(
      await errorCode(
        owner.call().catalog.applyCircuitTemplate({
          tableId,
          templateKey: "simple_review",
        }),
      ),
    ).toBe("invalid_status");
    await owner.call().catalog.applyCircuitTemplate({
      tableId,
      templateKey: "simple_review",
      remap: { submitted: "in_review" },
    });
    expect(await statusOf(tableId, rowId)).toBe("in_review");
    const moved = await db
      .selectFrom("auditEvents")
      .select("action")
      .where("tableId", "=", tableId)
      .where("recordId", "=", rowId)
      .where("action", "=", "transition")
      .execute();
    expect(moved).toHaveLength(1);
  });

  it("frees no sealed row, whatever the circuit or the remap", async () => {
    const tableId = await newTable("Contracts");
    await owner
      .call()
      .catalog.applyCircuitTemplate({ tableId, templateKey: "simple_review" });
    const rowId = await addRow(tableId, "K-1");
    await owner
      .call()
      .rows.transition({ tableId, rowId, transitionKey: "submit" });
    await owner
      .call()
      .rows.transition({ tableId, rowId, transitionKey: "approve" });

    for (const remap of [{ approved: "draft" }, { approved: "signed" }]) {
      expect(
        await errorCode(
          owner.call().catalog.applyCircuitTemplate({
            tableId,
            templateKey: "compliance",
            remap,
          }),
        ),
      ).toBe("row_locked");
    }
    expect(await statusOf(tableId, rowId)).toBe("approved");
    expect((await owner.call().catalog.getCircuit({ tableId })).key).toBe(
      "simple_review",
    );
  });
});
