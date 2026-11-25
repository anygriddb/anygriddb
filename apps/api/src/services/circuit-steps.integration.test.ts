/**
 * What a step of a table's circuit asks (ADR 0124, ADR 0130): someone who
 * takes steps and whom the step names, a role made to validate included;
 * a second person after the first (four eyes); a reason; the fields it
 * needs filled; a signature proved by password or second factor, which no
 * token gives. Each refusal says what is missing.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@anygriddb/db";
import type { TaskList } from "graphile-worker";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../auth/tokens.js";
import { keyRing } from "../auth/key-ring.js";
import { createMadeRole } from "../data/made-roles.js";
import { readEnv, type Env } from "../env.js";
import { DiskStore } from "../files/index.js";
import { transitionRecord } from "../public-api/index.js";
import { runJobs } from "../queue/run-once.test-helpers.js";
import { taskGroups } from "../queue/tasks.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { requestActor } from "../auth/access.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  joinBase,
  nextTotp,
  signUpProved,
  type TestBrowser,
} from "../trpc/caller.test-helpers.js";
import { definitionOf } from "@anygriddb/core";

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
const secret = randomBytes(32);

describe("the steps of a table's circuit", () => {
  let db: Database;
  /** The database's owner: the application only reads circuits. */
  let ownerDb: Database;
  let url = "";
  let close: (() => Promise<void>) | undefined;
  let pool: pg.Pool;
  let tasks: TaskList;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(secret),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const owner = browser();
  const second = browser();
  const editor = browser();
  const validator = browser();
  const writer = browser();
  const ids = { owner: "", second: "", editor: "", validator: "", writer: "" };
  let ownerTotp = "";
  let baseId = "";
  let validates = "";

  const newTable = async (name: string) =>
    (
      await owner.call().catalog.createTable({
        baseId,
        name,
        columns: [
          { name: "ref", label: "Ref", fieldType: "text" },
          { name: "note", label: "Note", fieldType: "text" },
        ],
      })
    ).id;
  const addRow = async (tableId: string, ref: string | null) =>
    (
      await owner
        .call()
        .rows.insert({ tableId, values: ref === null ? {} : { ref } })
    ).id;
  const step = (
    who: TestBrowser,
    tableId: string,
    rowId: string,
    transitionKey: string,
    extra: {
      reason?: string;
      meaning?: string;
      password?: string;
      factorCode?: string;
    } = {},
    headers: Record<string, string> = {},
  ) =>
    who
      .call(headers)
      .rows.transition({ tableId, rowId, transitionKey, ...extra });
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
  /**
   * Changes what a step of the table's circuit asks, as its manager does
   * in the table's settings.
   */
  const ask = (
    tableId: string,
    key: string,
    change: {
      requireReason?: boolean;
      requireFields?: string[];
      signature?: "none" | "password" | "step_up";
    },
  ) =>
    ownerDb
      .updateTable("statusTransitions")
      .set({
        ...change,
        ...(change.requireFields
          ? {
              requireFields: sql<string[]>`array[${sql.join(
                change.requireFields,
              )}]::text[]`,
            }
          : {}),
      })
      .where("key", "=", key)
      .where("circuitId", "in", (eb) =>
        eb
          .selectFrom("statusCircuits")
          .select("id")
          .where("tableId", "=", tableId),
      )
      .execute();
  /** Names a made role on a step, as the circuit's editor does. */
  const name = (tableId: string, key: string, madeRoleId: string) =>
    sql`
      insert into status_transition_grants (transition_id, made_role_id)
      select t.id, ${madeRoleId}::uuid from status_transitions t
        join status_circuits c on c.id = t.circuit_id
       where c.table_id = ${tableId}::uuid and t.key = ${key}
    `.execute(ownerDb);

  beforeAll(async () => {
    const created = await createTestDatabase("circuit_steps");
    db = created.db;
    ownerDb = created.owner.db;
    url = created.url;
    close = created.close;
    pool = new pg.Pool({ connectionString: url, max: 4 });
    pool.on("error", () => undefined);
    const groups = taskGroups({
      db,
      bus: recordingBus().bus,
      env: readEnv({
        DATABASE_URL: url,
        AUTH_ENCRYPTION_KEY: secret.toString("base64"),
      }),
      files: new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-files-"))),
      log: () => undefined,
    });
    tasks = Object.assign(
      {},
      ...groups.map((group) => group.tasks),
    ) as TaskList;

    await owner.signUpFirst({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: PASSWORD,
    });
    ownerTotp = await enrollTotp(owner);
    ids.owner = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", `owner-${suffix}@example.org`)
        .executeTakeFirstOrThrow()
    ).id;
    baseId = (await owner.call().catalog.createBase({ name: "Reviews" })).id;
    for (const [who, key, role] of [
      [second, "second", "owner"],
      [editor, "editor", "editor"],
      [validator, "validator", "viewer"],
      [writer, "writer", "viewer"],
    ] as const) {
      ids[key] = await signUpProved(who, db, {
        email: `${key}-${suffix}@example.org`,
        displayName: key,
        password: PASSWORD,
      });
      await enrollTotp(who);
      await joinBase(db, { baseId, userId: ids[key], role });
    }
    validates = (
      await createMadeRole(db, ids.owner, {
        name: "Validator",
        permissions: ["rows.read", "rows.transition"],
      })
    ).id;
    const writes = await createMadeRole(db, ids.owner, {
      name: "Writer",
      permissions: ["rows.read", "rows.write"],
    });
    for (const [key, role] of [
      ["validator", validates],
      ["writer", writes.id],
    ] as const) {
      await owner.call().catalog.grant({
        baseId,
        email: `${key}-${suffix}@example.org`,
        role,
      });
    }
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await close?.();
  });

  it("lets a role made to validate take the step it is named on, and only that", async () => {
    const tableId = await newTable("Checks");
    await name(tableId, "lock", validates);
    const row = await addRow(tableId, "A");
    await step(editor, tableId, row, "submit");
    await step(validator, tableId, row, "lock");
    expect(await statusOf(tableId, row)).toBe("locked");
    // It writes no row, and takes no step it is not named on.
    const other = await addRow(tableId, "B");
    expect(await errorCode(step(validator, tableId, other, "submit"))).toBe(
      "invalid_status",
    );
    expect(
      await errorCode(
        validator.call().rows.updateMany({
          tableId,
          updates: [{ rowId: other, values: { ref: "C" } }],
        }),
      ),
    ).toBe("access_denied");
    // Writing rows without taking steps takes none.
    expect(await errorCode(step(writer, tableId, other, "submit"))).toBe(
      "access_denied",
    );
  });

  it("asks a second person after the first, with four eyes", async () => {
    const tableId = await newTable("Approvals");
    await applyTemplate(owner, { tableId, templateKey: "dual_approval" });
    const row = await addRow(tableId, "A");
    await step(editor, tableId, row, "submit");
    await step(owner, tableId, row, "approve_first");
    expect(await errorCode(step(owner, tableId, row, "approve_second"))).toBe(
      "four_eyes",
    );
    await step(second, tableId, row, "approve_second");
    expect(await statusOf(tableId, row)).toBe("approved");
  });

  it("asks the reason a step names, and keeps it on the trail", async () => {
    const tableId = await newTable("Reasons");
    await ask(tableId, "submit", { requireReason: true });
    const row = await addRow(tableId, "A");
    expect(await errorCode(step(editor, tableId, row, "submit"))).toBe(
      "reason_required",
    );
    await step(editor, tableId, row, "submit", { reason: "Checked twice" });
    const event = await db
      .selectFrom("auditEvents")
      .select(["action", "reason"])
      .where("recordId", "=", row)
      .where("action", "=", "submit")
      .executeTakeFirstOrThrow();
    expect(event.reason).toBe("Checked twice");
  });

  it("asks the fields a step needs, as the row holds them", async () => {
    const tableId = await newTable("Fields");
    await ask(tableId, "submit", { requireFields: ["ref"] });
    const row = await addRow(tableId, null);
    const refused = editor
      .call()
      .rows.transition({ tableId, rowId: row, transitionKey: "submit" });
    await expect(refused).rejects.toMatchObject({
      cause: { code: "value_required", detail: "Ref" },
    });
    await owner.call().rows.updateMany({
      tableId,
      updates: [{ rowId: row, values: { ref: "A" } }],
    });
    await step(editor, tableId, row, "submit");
    expect(await statusOf(tableId, row)).toBe("submitted");
  });

  it("signs with its signer's password and meaning, or not at all", async () => {
    const tableId = await newTable("Signatures");
    const row = await addRow(tableId, "A");
    await step(editor, tableId, row, "submit");
    await step(owner, tableId, row, "lock");
    expect(
      await errorCode(
        step(owner, tableId, row, "sign", {
          meaning: "Approved",
          password: "not the password at all",
        }),
      ),
    ).toBe("invalid_credentials");
    expect(
      await errorCode(
        step(owner, tableId, row, "sign", { password: PASSWORD }),
      ),
    ).toBe("meaning_required");
    await step(owner, tableId, row, "sign", {
      meaning: "Approved",
      password: PASSWORD,
    });
    expect(await statusOf(tableId, row)).toBe("signed");
    const signed = await db
      .selectFrom("rowSignatures")
      .select(["userId", "meaning"])
      .where("recordId", "=", row)
      .execute();
    expect(signed).toEqual([{ userId: ids.owner, meaning: "Approved" }]);
  });

  it("signs with a second factor where the step asks it, never by a token", async () => {
    const tableId = await newTable("Second factors");
    await ask(tableId, "sign", { signature: "step_up" });
    const row = await addRow(tableId, "A");
    await step(editor, tableId, row, "submit");
    await step(owner, tableId, row, "lock");
    expect(
      await errorCode(
        step(owner, tableId, row, "sign", {
          meaning: "Verified",
          factorCode: "000000",
        }),
      ),
    ).toBe("invalid_credentials");
    const token = {
      authorization: `Bearer ${(await createApiToken(db, ids.owner, "Script", { days: 1 })).token}`,
    };
    expect(
      await errorCode(
        step(
          owner,
          tableId,
          row,
          "sign",
          { meaning: "Verified", password: PASSWORD },
          token,
        ),
      ),
    ).toBe("signature_in_app");
    await step(owner, tableId, row, "sign", {
      meaning: "Verified",
      factorCode: nextTotp(ownerTotp),
    });
    expect(await statusOf(tableId, row)).toBe("signed");
  });

  it("takes a step through the API with a token, as the panel does", async () => {
    const tableId = await newTable("Through the API");
    const row = await addRow(tableId, "A");
    const actor = await requestActor(
      db,
      {
        authorization: `Bearer ${(await createApiToken(db, ids.editor, "Script", { days: 1 })).token}`,
      },
      undefined,
    );
    if (!actor) throw new Error("the token names nobody");
    const deps = {
      db,
      bus: recordingBus().bus,
      publicUrl: "https://grid.example.org",
      log: () => undefined,
    };
    expect(
      await transitionRecord(deps, actor, tableId, row, {
        transition: "submit",
      }),
    ).toEqual({
      id: row,
      from: "draft",
      to: "submitted",
      transition: "submit",
    });
    expect(
      await errorCode(
        transitionRecord(deps, actor, tableId, row, { transition: "lock" }),
      ),
    ).toBe("invalid_status");
  });

  it("starts an automation when a row takes the step it names", async () => {
    const tableId = await newTable("Automated");
    await owner.call().automations.create({
      tableId,
      name: "Noted",
      trigger: { type: "step_taken", transition: "submit" },
      actions: [{ type: "update_record", values: { note: "submitted" } }],
    });
    const row = await addRow(tableId, "A");
    await runJobs(pool, tasks);
    await step(editor, tableId, row, "submit");
    await runJobs(pool, tasks);
    const read = await owner.call().rows.get({ tableId, rowIds: [row] });
    expect(read.rows[0]?.note).toBe("submitted");
  });
});
