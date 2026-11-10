import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeAttachment } from "./attachments.js";
import { withAudit } from "./data/audit-context.js";
import { exportBaseSnapshot } from "./data/base-snapshot.js";
import { loadEngine } from "./data/engine.js";
import { insertNativeBatch } from "./services/rows.js";
import { insertBase, insertTable } from "./data/schema-ops.js";
import { DiskStore, readFile } from "./files/index.js";
import { jobRunners } from "./job-runners.js";
import type { JobRow } from "./jobs.js";
import { createTestDatabase } from "./test-database.js";

const suffix = randomBytes(6).toString("hex");

describe("duplicating a base", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let viewer = "";
  let baseId = "";
  let runners: ReturnType<typeof jobRunners>;
  let files: DiskStore;
  let noteKey = "";

  beforeAll(async () => {
    const created = await createTestDatabase("duplicate_base");
    db = created.db;
    close = created.close;
    const people = await db
      .insertInto("users")
      .values([
        { email: `dup-${suffix}@example.com`, displayName: "Owner" },
        { email: `dup-viewer-${suffix}@example.com`, displayName: "Viewer" },
      ])
      .returning("id")
      .execute();
    owner = people[0]?.id ?? "";
    viewer = people[1]?.id ?? "";
    baseId = (await insertBase(db, owner, { name: "Ventes" })).id;
    await withAudit(db, { userId: owner, source: "web" }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values({
          userId: viewer,
          role: "viewer",
          scope: "base",
          scopeId: baseId,
        })
        .execute(),
    );
    const table = await insertTable(db, owner, {
      baseId,
      name: "Clients",
      columns: [
        { name: "name", label: "Nom", fieldType: "text" },
        { name: "files", label: "Pièces", fieldType: "attachment" },
        {
          name: "owner",
          label: "Suivi par",
          fieldType: "user",
          config: { multiple: true },
        },
      ],
    });
    files = new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-dup-")));
    const note = await storeAttachment(db, files, {
      tableId: table.id,
      userId: owner,
      filename: "contrat.txt",
      bytes: Buffer.from("Contrat signé\n", "utf8"),
    });
    noteKey = note.key;
    const { engine } = await loadEngine(db, table.id, () => true);
    const row = await db
      .selectFrom("dataTables")
      .select("physicalName")
      .where("id", "=", table.id)
      .executeTakeFirstOrThrow();
    await insertNativeBatch(
      db,
      engine,
      {
        userId: owner,
        tableId: table.id,
        physicalName: row.physicalName,
        baseId,
        reason: null,
        source: "web",
      },
      [
        { name: "Acme", files: [note.key], owner: [owner, viewer] },
        { name: "Globex" },
      ],
    );
    runners = jobRunners({
      db,
      bus: { publish: async () => undefined } as never,
      files,
      log: () => undefined,
    });
  });

  afterAll(async () => {
    await close?.();
  });

  function job(userId: string): JobRow {
    return {
      id: "00000000-0000-4000-8000-000000000001",
      userId,
      input: { baseId, name: "Ventes (copie)", withData: true },
    } as never;
  }

  it("copies the base, its tables, and their rows into a new base", async () => {
    const steps: Array<[number, number | null]> = [];
    const outcome = await runners.duplicate_base({
      job: job(owner),
      progress: async (done, total) => {
        steps.push([done, total ?? null]);
      },
    });
    const copyId = outcome.result?.baseId as string;
    expect(copyId).toBeTruthy();
    expect(copyId).not.toBe(baseId);
    const copy = await db
      .selectFrom("bases")
      .select("name")
      .where("id", "=", copyId)
      .executeTakeFirstOrThrow();
    expect(copy.name).toBe("Ventes (copie)");
    const tables = await db
      .selectFrom("dataTables")
      .select(["id", "name"])
      .where("baseId", "=", copyId)
      .execute();
    expect(tables.map((table) => table.name)).toEqual(["Clients"]);
    // Its rows came with it.
    const { snapshot } = await exportBaseSnapshot(db, copyId, {
      withData: true,
    });
    expect(snapshot.tables[0]?.rows?.map((row) => row.name).sort()).toEqual([
      "Acme",
      "Globex",
    ]);
    // Its files were stored again, under new keys, and the people who
    // are not members of the copy left its user cells.
    const acme = snapshot.tables[0]?.rows?.find((item) => item.name === "Acme");
    const copied = acme?.files as Array<{ file: string; name: string }>;
    expect(copied).toEqual([{ file: expect.any(String), name: "contrat.txt" }]);
    expect(copied[0]?.file).not.toBe(noteKey);
    const bytes = await readFile(files, copied[0]?.file ?? "", 1_000);
    expect(bytes?.bytes.toString("utf8")).toBe("Contrat signé\n");
    expect(acme?.owner).toEqual([`dup-${suffix}@example.com`]);
    expect(outcome.result?.report).toMatchObject({
      files: 1,
      filesMissing: 0,
      people: 1,
      peopleDropped: 1,
    });
    // Progress only moves forward, over reading and then writing.
    expect(steps.at(-1)).toEqual([1_000, 1_000]);
    for (let index = 1; index < steps.length; index += 1) {
      expect(steps[index]?.[0] ?? 0).toBeGreaterThanOrEqual(
        steps[index - 1]?.[0] ?? 0,
      );
    }
  });

  it("refuses an author who does not manage the base", async () => {
    await expect(
      runners.duplicate_base({ job: job(viewer), progress: async () => {} }),
    ).rejects.toThrow();
  });
});
