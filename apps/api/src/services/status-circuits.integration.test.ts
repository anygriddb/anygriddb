/**
 * A table's status circuit (ADR 0124) through the API: a template applied,
 * rows moved along its transitions by the roles it names, rows of a state
 * it drops moved on the trail, and a sealed row that no change frees.
 */
import { randomBytes, randomUUID } from "node:crypto";
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
  type TestBrowser,
} from "../trpc/caller.test-helpers.js";
import { type CircuitDefinition, definitionOf } from "@anygriddb/core";

/**
 * Saves a shipped template's circuit on a table, as the editor does when
 * it starts from one.
 */
async function applyTemplate(
  who: TestBrowser,
  input: {
    tableId: string;
    templateKey: string;
    remap?: Record<string, string>;
  },
) {
  const template = (await who.call().catalog.listCircuitTemplates({})).find(
    (circuit) => circuit.key === input.templateKey,
  );
  if (!template) throw new Error(`no template ${input.templateKey}`);
  return who.call().catalog.saveCircuit({
    tableId: input.tableId,
    circuit: definitionOf(template),
    remap: input.remap,
  });
}

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
    const circuit = await applyTemplate(owner, {
      tableId,
      templateKey: "simple_review",
    });
    expect(circuit.states.map((state) => state.key)).toEqual([
      "draft",
      "in_review",
      "approved",
    ]);
    expect(circuit.name).toBe("Simple review");
    // An editor may not change it.
    expect(
      await errorCode(
        applyTemplate(editor, { tableId, templateKey: "compliance" }),
      ),
    ).toBe("access_denied");
  });

  it("moves a row along the circuit, each step by the roles it names", async () => {
    const tableId = await newTable("Reports");
    await applyTemplate(owner, { tableId, templateKey: "simple_review" });
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
        applyTemplate(owner, {
          tableId,
          templateKey: "simple_review",
        }),
      ),
    ).toBe("invalid_status");
    await applyTemplate(owner, {
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
    await applyTemplate(owner, { tableId, templateKey: "simple_review" });
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
          applyTemplate(owner, {
            tableId,
            templateKey: "compliance",
            remap,
          }),
        ),
      ).toBe("row_locked");
    }
    expect(await statusOf(tableId, rowId)).toBe("approved");
    // The circuit stayed as it was: its approved state, sealed.
    const kept = await owner.call().catalog.getCircuit({ tableId });
    expect(kept.name).toBe("Simple review");
    expect(kept.states.find((state) => state.key === "approved")?.seal).toBe(
      true,
    );
  });

  it("saves a circuit its manager drew, checked against the table", async () => {
    const tableId = await newTable("Drawn");
    const drawn: CircuitDefinition = {
      name: "Checks",
      states: [
        {
          key: "draft",
          label: "Draft",
          initial: true,
          writable: true,
          writableFields: null,
          delete: true,
          seal: false,
        },
        {
          key: "checked",
          label: "Checked",
          initial: false,
          writable: false,
          writableFields: null,
          delete: false,
          seal: false,
        },
        {
          key: "done",
          label: "Done",
          initial: false,
          writable: false,
          writableFields: null,
          delete: false,
          seal: true,
        },
      ],
      steps: [
        {
          key: "check",
          label: "Check",
          from: "draft",
          to: "checked",
          reason: true,
          fields: ["ref"],
          signature: "none",
          fourEyes: false,
          roles: ["editor", "owner"],
          madeRoles: [],
        },
        {
          key: "close",
          label: "Close",
          from: "checked",
          to: "done",
          reason: false,
          fields: [],
          signature: "none",
          fourEyes: true,
          roles: ["owner"],
          madeRoles: [],
        },
      ],
    };
    const save = (
      who: TestBrowser,
      circuit: CircuitDefinition,
      remap?: Record<string, string>,
    ) => who.call().catalog.saveCircuit({ tableId, circuit, remap });
    expect(await errorCode(save(editor, drawn))).toBe("access_denied");
    const [check, close] = drawn.steps;
    if (!check || !close) throw new Error("two steps");
    expect(
      await errorCode(
        save(owner, {
          ...drawn,
          steps: [{ ...check, fields: ["nope"] }, close],
        }),
      ),
    ).toBe("invalid_column");
    expect(
      await errorCode(
        save(owner, {
          ...drawn,
          steps: [{ ...check, madeRoles: [randomUUID()] }, close],
        }),
      ),
    ).toBe("unknown_role");

    // A row in a state that goes: the editor is told how many, and where
    // they go is asked.
    const rowId = await addRow(tableId, "D-1");
    await owner.call().rows.setStatus({ tableId, rowId, status: "submitted" });
    expect(await owner.call().catalog.circuitCounts({ tableId })).toMatchObject(
      { submitted: 1 },
    );
    expect(await errorCode(save(owner, drawn))).toBe("invalid_status");
    const saved = await save(owner, drawn, { submitted: "draft" });
    expect(saved.name).toBe("Checks");
    expect(await statusOf(tableId, rowId)).toBe("draft");

    // Its steps ask what they were drawn to.
    expect(
      await errorCode(
        editor
          .call()
          .rows.transition({ tableId, rowId, transitionKey: "check" }),
      ),
    ).toBe("reason_required");
    await editor.call().rows.transition({
      tableId,
      rowId,
      transitionKey: "check",
      reason: "Seen",
    });
    expect(await statusOf(tableId, rowId)).toBe("checked");
  });
  it("holds a state's writable fields, and lets a field's conversion through", async () => {
    const { id: tableId } = await owner.call().catalog.createTable({
      baseId,
      name: "Reviewed",
      columns: ["ref", "note", "amount"].map((name) => ({
        name,
        label: name,
        fieldType: "text" as const,
      })),
    });
    const state = (
      key: string,
      writableFields: string[] | null,
      writable = true,
    ) => ({
      key,
      label: key,
      initial: key === "draft",
      writable,
      writableFields,
      delete: key === "draft",
      seal: false,
    });
    const step = (key: string, from: string, to: string) => ({
      key,
      label: key,
      from,
      to,
      reason: false,
      fields: [],
      signature: "none" as const,
      fourEyes: false,
      roles: ["editor" as const, "owner" as const],
      madeRoles: [],
    });
    await owner.call().catalog.saveCircuit({
      tableId,
      circuit: {
        name: "Notes in review",
        states: [
          state("draft", null),
          state("review", ["note"]),
          state("done", null, false),
        ],
        steps: [
          step("submit", "draft", "review"),
          step("finish", "review", "done"),
        ],
      },
    });
    const { id: rowId } = await owner.call().rows.insert({
      tableId,
      values: { ref: "R-1", note: "", amount: "5" },
    });
    await editor
      .call()
      .rows.transition({ tableId, rowId, transitionKey: "submit" });
    const write = (who: TestBrowser, values: Record<string, string>) =>
      errorCode(
        who.call().rows.updateMany({ tableId, updates: [{ rowId, values }] }),
      );
    // In review, only the note is written, by whoever writes the table.
    for (const who of [editor, owner]) {
      expect(await write(who, { ref: "R-1b" })).toBe("row_locked");
      expect(await write(who, { note: "seen", ref: "R-1b" })).toBe(
        "row_locked",
      );
    }
    expect(await write(editor, { note: "seen" })).toBe("ok");
    // A field's conversion is no write of its rows' values.
    await owner
      .call()
      .catalog.updateColumn({ tableId, name: "amount", fieldType: "number" });
    const { rows } = await owner.call().rows.read({ tableId, limit: 10 });
    expect(rows[0]).toMatchObject({ ref: "R-1", note: "seen", amount: "5" });
    expect(await statusOf(tableId, rowId)).toBe("review");
    await owner
      .call()
      .rows.transition({ tableId, rowId, transitionKey: "finish" });
    expect(await write(owner, { note: "late" })).toBe("row_locked");
  });
});
