/**
 * What a base's copies keep of its rows (ADR 0117), against a real database:
 * a restore point and a copy made by the instance bring back each row's
 * dates, authors, and status, through the trail's own transitions. A file
 * that comes from outside is believed on none of it, and is read whole
 * before a base is made of it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { madeNames } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeAttachment } from "../attachments.js";
import { DiskStore } from "../files/index.js";
import { jobRunners } from "../job-runners.js";
import type { JobRow } from "../jobs.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { withAudit } from "./audit-context.js";
import { importBaseSnapshot } from "./base-snapshot.js";
import { loadEngine } from "./engine.js";
import { addRelation, setLinks } from "./relations.js";
import {
  makeRestorePoint,
  restoreFromPoint,
  restorePointKey,
} from "./restore-points.js";
import {
  insertRows,
  setRowStatus,
  signRow,
  updateRows,
  type WriteContext,
} from "./rows.js";
import { insertBase, insertTable } from "./schema-ops.js";
import { openStagedSnapshot, stageSnapshotFile } from "./snapshot-stage.js";
import { snapshotOf } from "./snapshot.test-helpers.js";
import { ZipReader, ZipWriter } from "./zip.js";

const suffix = randomBytes(6).toString("hex");

type Line = Record<string, unknown>;

/** An archive written again, with its JSON, its lines, or a file changed. */
async function rewritten(
  from: string,
  to: string,
  change: {
    snapshot?: (doc: Record<string, unknown>) => void;
    lines?: (rows: Line[]) => void;
    file?: (bytes: Buffer) => Buffer;
  },
): Promise<number> {
  const reader = await ZipReader.open(from, { maxEntries: 1_000 });
  const writer = new ZipWriter(to);
  for (const name of reader.entries.keys()) {
    let bytes = (await reader.read(name, 64 * 1024 * 1024)) ?? Buffer.alloc(0);
    if (name === "snapshot.json" && change.snapshot) {
      const doc = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      change.snapshot(doc);
      bytes = Buffer.from(JSON.stringify(doc), "utf8");
    } else if (name === "rows/patients.ndjson" && change.lines) {
      const rows = bytes
        .toString("utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Line);
      change.lines(rows);
      bytes = Buffer.from(
        `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
        "utf8",
      );
    } else if (name.startsWith("files/") && change.file) {
      bytes = change.file(bytes);
    }
    await writer.addBuffer(name, bytes);
  }
  return writer.finish();
}

describe("what a base's copies keep of its rows", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let files: DiskStore;
  let folder = "";
  let owner = "";
  let ada = "";
  let baseId = "";
  let patients = "";
  let visits = "";
  const ids = { draft: "", submitted: "", locked: "", signed: "", visit: "" };
  const deps = () => ({ db, files, maxRows: 1_000_000 });
  const restoreDeps = () => ({
    ...deps(),
    maxFileBytes: 1024 * 1024,
    names: madeNames(),
  });

  async function physicalOf(tableId: string): Promise<string> {
    const found = await db
      .selectFrom("dataTables")
      .select("physicalName")
      .where("id", "=", tableId)
      .executeTakeFirstOrThrow();
    return found.physicalName;
  }

  async function context(
    tableId: string,
    userId: string,
    base = baseId,
  ): Promise<WriteContext> {
    return {
      userId,
      tableId,
      physicalName: await physicalOf(tableId),
      baseId: base,
      reason: null,
      source: "test",
    };
  }

  /** Each row's system columns as the database holds them, by number. */
  async function stateOf(tableId: string) {
    const table = await physicalOf(tableId);
    const { rows } = await sql<{
      seq: string;
      id: string;
      status: string;
      createdAt: string;
      updatedAt: string;
      createdBy: string | null;
      updatedBy: string | null;
    }>`select "ag_seq"::text as "seq", "id", "ag_status" as "status", to_char("ag_created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as "createdAt", to_char("ag_updated_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as "updatedAt", "ag_created_by"::text as "createdBy", "ag_updated_by"::text as "updatedBy" from ${sql.table(table)} order by "ag_seq"`.execute(
      db,
    );
    return rows;
  }

  const withoutIds = (rows: Awaited<ReturnType<typeof stateOf>>) =>
    rows.map(({ id: _id, ...row }) => row);

  /** What a copy must show: the same rows, a signed one come back locked. */
  const expectedFrom = (rows: Awaited<ReturnType<typeof stateOf>>) =>
    withoutIds(rows).map((row) =>
      row.status === "signed" ? { ...row, status: "locked" } : row,
    );

  async function tableOf(base: string, name: string): Promise<string> {
    const found = await db
      .selectFrom("dataTables")
      .select("id")
      .where("baseId", "=", base)
      .where("name", "=", name)
      .executeTakeFirstOrThrow();
    return found.id;
  }

  const countBases = async () =>
    Number(
      (
        await db
          .selectFrom("bases")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow()
      ).count,
    );

  /** The base's archive as a person downloads it. */
  async function exported(name: string) {
    const written = await snapshotOf(db, files, baseId, { withData: true });
    if (written.packed.kind !== "zip") throw new Error("not an archive");
    const path = join(folder, `${name}.zip`);
    await writeFile(path, await readFile(written.packed.path));
    await written.close();
    return path;
  }

  /** The upload's job, as the queue runs it. */
  function importJob(snapshotId: string): Promise<unknown> {
    const runners = jobRunners({
      db,
      bus: { publish: async () => undefined } as never,
      files,
      log: () => undefined,
    });
    return runners.import_snapshot({
      job: {
        id: randomUUID(),
        userId: owner,
        input: { snapshotId, restoreMembers: false },
      } as unknown as JobRow,
      progress: async () => undefined,
    });
  }

  async function stage(path: string) {
    const { size } = await stat(path);
    return stageSnapshotFile(db, files, {
      userId: owner,
      path,
      size,
      filename: "base.anygriddb.zip",
    });
  }

  beforeAll(async () => {
    const created = await createTestDatabase("snapshot_row_state");
    db = created.db;
    close = created.close;
    folder = await mkdtemp(join(tmpdir(), "anygriddb-row-state-"));
    files = new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-files-")));
    [owner, ada] = (
      await db
        .insertInto("users")
        .values([
          { email: `owner-${suffix}@example.com`, displayName: "Owner" },
          { email: `ada-${suffix}@example.com`, displayName: "Ada" },
        ])
        .returning("id")
        .execute()
    ).map((row) => row.id) as [string, string];
    baseId = (await insertBase(db, owner, { name: "Essais" })).id;
    await withAudit(db, { userId: owner }, (tx) =>
      tx
        .insertInto("attributions")
        .values({
          userId: ada,
          role: "editor",
          scope: "base",
          scopeId: baseId,
        })
        .execute(),
    );
    patients = (
      await insertTable(db, owner, {
        baseId,
        name: "Patients",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "note", label: "Note", fieldType: "text" },
          { name: "docs", label: "Docs", fieldType: "attachment" },
        ],
      })
    ).id;
    visits = (
      await insertTable(db, owner, {
        baseId,
        name: "Visits",
        columns: [{ name: "label", label: "Label", fieldType: "text" }],
      })
    ).id;
    await addRelation(db, owner, {
      tableId: visits,
      name: "patient",
      label: "Patient",
      kind: "one_to_many",
      targetTableId: patients,
      twoWay: true,
      inverseLabel: "Visits",
    });
    await addRelation(db, owner, {
      tableId: visits,
      name: "seen",
      label: "Seen",
      kind: "many_to_many",
      targetTableId: patients,
      twoWay: false,
    });
    const file = await storeAttachment(db, files, {
      tableId: patients,
      userId: ada,
      filename: "consent.txt",
      bytes: Buffer.from("Consent given\n", "utf8"),
    });
    const patient = await loadEngine(db, patients, () => true);
    const written = await insertRows(
      db,
      patient.engine,
      await context(patients, ada),
      [
        { name: "Draft", docs: [file.key] },
        { name: "Submitted" },
        { name: "Locked" },
        { name: "Signed" },
      ],
    );
    [ids.draft, ids.submitted, ids.locked, ids.signed] = written as [
      string,
      string,
      string,
      string,
    ];
    await updateRows(db, patient.engine, await context(patients, owner), [
      { rowId: ids.draft, values: { note: "Edited by the owner" } },
    ]);
    const visit = await loadEngine(db, visits, () => true);
    const [lockedVisit] = await insertRows(
      db,
      visit.engine,
      await context(visits, ada),
      [{ label: "First visit" }],
    );
    ids.visit = lockedVisit ?? "";
    for (const name of ["patient", "seen"]) {
      const column = visit.engine.table.columns.find(
        (item) => item.name === name,
      );
      if (!column) throw new Error(`no link ${name}`);
      await setLinks(db, visit.engine, {
        userId: owner,
        tableId: visits,
        physicalName: await physicalOf(visits),
        column,
        rowId: ids.visit,
        targetIds: [ids.locked],
        reason: null,
        source: "test",
      });
    }
    const status = async (
      tableId: string,
      rowId: string,
      steps: Array<"submitted" | "locked">,
    ) => {
      for (const next of steps) {
        await setRowStatus(db, {
          userId: owner,
          role: "owner",
          table: { id: tableId, physicalName: await physicalOf(tableId) },
          rowId,
          status: next,
        });
      }
    };
    await status(patients, ids.submitted, ["submitted"]);
    await status(patients, ids.locked, ["submitted", "locked"]);
    await status(patients, ids.signed, ["submitted", "locked"]);
    await status(visits, ids.visit, ["submitted", "locked"]);
    await signRow(db, {
      userId: owner,
      table: { id: patients, physicalName: await physicalOf(patients) },
      rowId: ids.signed,
      meaning: "Reviewed",
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
    await rm(folder, { recursive: true, force: true });
  });

  it("brings each row back from a restore point with its dates, authors, and status", async () => {
    const before = {
      patients: await stateOf(patients),
      visits: await stateOf(visits),
    };
    const point = await makeRestorePoint(deps(), { userId: owner, baseId });
    const restored = await restoreFromPoint(restoreDeps(), {
      userId: owner,
      restorePointId: point.id,
      name: "Essais (restored)",
    });
    const newPatients = await tableOf(restored.baseId, "Patients");
    const newVisits = await tableOf(restored.baseId, "Visits");
    const after = await stateOf(newPatients);
    expect(withoutIds(after)).toEqual(expectedFrom(before.patients));
    expect(withoutIds(await stateOf(newVisits))).toEqual(
      expectedFrom(before.visits),
    );
    expect(after.map((row) => row.status)).toEqual([
      "draft",
      "submitted",
      "locked",
      "locked",
    ]);
    // A signature is not carried: it signs the row it was given to.
    const signatures = await db
      .selectFrom("rowSignatures")
      .select("id")
      .where("tableId", "=", newPatients)
      .execute();
    expect(signatures).toEqual([]);
    expect(restored.report).toMatchObject({ files: 1, signaturesLeft: 1 });

    // The locked visit keeps its links.
    const visit = await loadEngine(db, newVisits, () => true);
    const fk = visit.engine.table.columns.find(
      (column) => column.name === "patient",
    )?.relation?.fkColumn;
    const junction = visit.engine.table.columns.find(
      (column) => column.name === "seen",
    )?.relation?.junction;
    const lockedPatient = after.find((row) => row.status === "locked");
    const { rows: linked } = await sql<{
      patient: string | null;
      seen: string;
    }>`select v.${sql.ref(fk ?? "")}::text as "patient", (select count(*)::text from ${sql.table(junction ?? "")}) as "seen" from ${sql.table(await physicalOf(newVisits))} v`.execute(
      db,
    );
    expect(linked).toEqual([{ patient: lockedPatient?.id, seen: "1" }]);

    // Each status came back through the trail's own transitions.
    const trail = await db
      .selectFrom("auditEvents")
      .select(["action", "source"])
      .where("tableId", "=", newPatients)
      .where("recordId", "=", lockedPatient?.id ?? "")
      .orderBy("occurredAt")
      .orderBy("id")
      .execute();
    expect(trail).toEqual([
      { action: "insert", source: "snapshot" },
      { action: "submit", source: "snapshot" },
      { action: "lock", source: "snapshot" },
    ]);
  }, 60_000);

  it("leaves a draft writable and refuses a write to a locked row, once restored", async () => {
    const point = await makeRestorePoint(deps(), { userId: owner, baseId });
    const restored = await restoreFromPoint(restoreDeps(), {
      userId: owner,
      restorePointId: point.id,
      name: "Essais (restored, written)",
    });
    const table = await tableOf(restored.baseId, "Patients");
    const rows = await stateOf(table);
    const { engine } = await loadEngine(db, table, () => true);
    const write = async (rowId: string) =>
      updateRows(db, engine, await context(table, owner, restored.baseId), [
        { rowId, values: { note: "Written after the restore" } },
      ]);
    const draft = rows.find((row) => row.status === "draft");
    await expect(write(draft?.id ?? "")).resolves.toBeDefined();
    const locked = rows.filter((item) => item.status === "locked");
    expect(locked).toHaveLength(2);
    for (const row of locked) {
      await expect(write(row.id)).rejects.toMatchObject({
        code: "row_locked",
      });
    }
  }, 60_000);

  it("keeps them in a copy of the base", async () => {
    const before = await stateOf(patients);
    const runners = jobRunners({
      db,
      bus: { publish: async () => undefined } as never,
      files,
      log: () => undefined,
    });
    const outcome = await runners.duplicate_base({
      job: {
        id: randomUUID(),
        userId: owner,
        input: { baseId, name: "Essais (copy)", withData: true },
      } as unknown as JobRow,
      progress: async () => undefined,
    });
    const copy = await tableOf(outcome.result?.baseId as string, "Patients");
    expect(withoutIds(await stateOf(copy))).toEqual(expectedFrom(before));
  }, 60_000);

  it("still reads a restore point made before it kept them", async () => {
    const written = await snapshotOf(db, files, baseId, { withData: true });
    if (written.packed.kind !== "zip") throw new Error("not an archive");
    const id = randomUUID();
    const key = restorePointKey(id);
    await files.put(
      key,
      await readFile(written.packed.path),
      "application/zip",
    );
    await db
      .insertInto("restorePoints")
      .values({
        id,
        baseId,
        createdBy: owner,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
        fileKey: key,
        size: written.packed.size,
        rows: written.rows,
        files: written.files,
        note: null,
      })
      .execute();
    await written.close();
    const restored = await restoreFromPoint(restoreDeps(), {
      userId: owner,
      restorePointId: id,
      name: "Essais (older point)",
    });
    const rows = await stateOf(await tableOf(restored.baseId, "Patients"));
    expect(rows.map((row) => row.status)).toEqual([
      "draft",
      "draft",
      "draft",
      "draft",
    ]);
  }, 60_000);

  it("believes an uploaded file on neither the dates nor the status of a row", async () => {
    const path = await exported("plain");
    const staged = await stage(path);
    const opened = await openStagedSnapshot(
      db,
      files,
      staged.snapshotId,
      owner,
    );
    await opened.verify(async () => undefined);
    const imported = await importBaseSnapshot(
      db,
      files,
      owner,
      opened.snapshot,
      {
        name: "Essais (uploaded)",
        readFile: opened.readFile,
        readLines: opened.readLines,
        maxRows: 1_000_000,
      },
    ).finally(opened.close);
    const before = await stateOf(patients);
    const rows = await stateOf(await tableOf(imported.baseId, "Patients"));
    expect(rows.map((row) => row.status)).toEqual([
      "draft",
      "draft",
      "draft",
      "draft",
    ]);
    expect(rows[0]?.createdAt).not.toBe(before[0]?.createdAt);
  }, 60_000);

  it("refuses an uploaded file that claims a row's state, and makes no base", async () => {
    const plain = await exported("claims");
    const count = await countBases();

    // The form an instance keeps for itself is not taken from outside.
    const kept = join(folder, "kept.zip");
    await rewritten(plain, kept, {
      snapshot: (doc) => {
        doc.version = 4;
      },
    });
    await expect(stage(kept)).rejects.toMatchObject({
      code: "invalid_snapshot",
    });

    for (const [name, claim] of [
      ["status", { __status: "signed" }],
      ["state", { "@row": "signed" }],
    ] as const) {
      const claiming = join(folder, `claim-${name}.zip`);
      await rewritten(plain, claiming, {
        lines: (rows) => {
          Object.assign(rows[0] ?? {}, claim);
        },
      });
      const staged = await stage(claiming);
      await expect(importJob(staged.snapshotId)).rejects.toMatchObject({
        code: "invalid_snapshot",
      });
    }
    expect(await countBases()).toBe(count);
  }, 60_000);

  it("refuses a damaged or mislabelled file before it makes a base", async () => {
    const plain = await exported("damaged");
    const count = await countBases();
    const damaged = join(folder, "flipped.zip");
    await rewritten(plain, damaged, {
      file: (bytes) => {
        const flipped = Buffer.from(bytes);
        flipped[0] = (flipped[0] ?? 0) ^ 0xff;
        return flipped;
      },
    });
    const mislabelled = join(folder, "wrong-sum.zip");
    await rewritten(plain, mislabelled, {
      snapshot: (doc) => {
        const listed = doc.files as Array<{ sha256: string }>;
        if (listed[0]) listed[0].sha256 = "0".repeat(64);
      },
    });
    for (const path of [damaged, mislabelled]) {
      const staged = await stage(path);
      await expect(importJob(staged.snapshotId)).rejects.toMatchObject({
        code: "invalid_snapshot",
      });
    }
    expect(await countBases()).toBe(count);
  }, 60_000);

  it("still counts apart a file of a type refused here", async () => {
    const path = await exported("refused-type");
    await writeSettings(db, owner, { attachmentRefusedExtensions: [".txt"] });
    try {
      const staged = await stage(path);
      const outcome = (await importJob(staged.snapshotId)) as {
        result: { report: Record<string, number> };
      };
      expect(outcome.result.report).toMatchObject({
        files: 0,
        filesMissing: 0,
        filesRefused: 1,
      });
    } finally {
      await writeSettings(db, owner, { attachmentRefusedExtensions: [] });
    }
  }, 60_000);

  it("refuses a row number a table could not go on from, and takes the highest it can", async () => {
    const plain = await exported("numbers");
    const count = await countBases();
    const tooHigh = join(folder, "seq-max.zip");
    await rewritten(plain, tooHigh, {
      lines: (rows) => {
        if (rows[0]) rows[0].__seq = "9223372036854775807";
      },
    });
    const refused = await stage(tooHigh);
    await expect(importJob(refused.snapshotId)).rejects.toMatchObject({
      code: "invalid_snapshot",
    });
    expect(await countBases()).toBe(count);

    const highest = join(folder, "seq-safe.zip");
    await rewritten(plain, highest, {
      lines: (rows) => {
        if (rows[0]) rows[0].__seq = String(Number.MAX_SAFE_INTEGER);
      },
    });
    const staged = await stage(highest);
    const outcome = (await importJob(staged.snapshotId)) as {
      result: { baseId: string };
    };
    const table = await tableOf(outcome.result.baseId, "Patients");
    const { engine } = await loadEngine(db, table, () => true);
    await expect(
      insertRows(
        db,
        engine,
        await context(table, owner, outcome.result.baseId),
        [{ name: "Added after the import" }],
      ),
    ).resolves.toHaveLength(1);
  }, 60_000);

  it("restores a point that holds numbers no table can go on from", async () => {
    const written = await snapshotOf(db, files, baseId, { withData: true });
    if (written.packed.kind !== "zip") throw new Error("not an archive");
    const far = join(folder, "far-point.zip");
    const size = await rewritten(written.packed.path, far, {
      lines: (rows) => {
        const last = rows.at(-1);
        if (last) {
          last.__seq = "9223372036854775807";
          last.__position = "9223372036854775807";
        }
        const first = rows[0];
        if (first) first.__position = "-9223372036854775807";
      },
    });
    const id = randomUUID();
    const key = restorePointKey(id);
    await files.put(key, await readFile(far), "application/zip");
    await db
      .insertInto("restorePoints")
      .values({
        id,
        baseId,
        createdBy: owner,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
        fileKey: key,
        size,
        rows: written.rows,
        files: written.files,
        note: null,
      })
      .execute();
    await written.close();
    const restored = await restoreFromPoint(restoreDeps(), {
      userId: owner,
      restorePointId: id,
      name: "Essais (far point)",
    });
    const table = await tableOf(restored.baseId, "Patients");
    const { rows } = await sql<{
      name: string;
      seq: string;
      position: string;
    }>`select "name", "ag_seq"::text as "seq", "ag_position"::text as "position" from ${sql.table(await physicalOf(table))} order by "ag_position", "ag_seq"`.execute(
      db,
    );
    expect(rows.map((row) => row.name)).toEqual([
      "Draft",
      "Submitted",
      "Locked",
      "Signed",
    ]);
    for (const row of rows) {
      expect(BigInt(row.seq)).toBeLessThan(2n ** 53n);
      expect(Math.abs(Number(row.position))).toBeLessThan(2 ** 53);
    }
    const { engine } = await loadEngine(db, visits, () => true);
    await expect(
      insertRows(db, engine, await context(visits, owner), [
        { label: "After a far point" },
      ]),
    ).resolves.toHaveLength(1);
    const copy = await loadEngine(db, table, () => true);
    await expect(
      insertRows(
        db,
        copy.engine,
        await context(table, owner, restored.baseId),
        [{ name: "Added to the restored table" }],
      ),
    ).resolves.toHaveLength(1);
  }, 60_000);

  it("keeps the values of fields named like a line's own keys", async () => {
    const named = await insertBase(db, owner, { name: "Keys" });
    const table = (
      await insertTable(db, owner, {
        baseId: named.id,
        name: "Patients",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "__seq", label: "Sequence", fieldType: "text" },
          { name: "__position", label: "Place", fieldType: "text" },
          { name: "__id", label: "Identifier", fieldType: "text" },
        ],
      })
    ).id;
    const { engine } = await loadEngine(db, table, () => true);
    await insertRows(db, engine, await context(table, owner, named.id), [
      { name: "Ada", __seq: "seq value", __position: "seq 2", __id: "id-1" },
      { name: "Grace", __seq: "12", __position: "1.5", __id: "id-2" },
    ]);
    const readBack = async (tableId: string) => {
      const { rows } = await sql<{
        name: string;
        s: string;
        p: string;
        i: string;
      }>`select "name", "__seq" as "s", "__position" as "p", "__id" as "i" from ${sql.table(await physicalOf(tableId))} order by "ag_seq"`.execute(
        db,
      );
      return rows;
    };
    const before = await readBack(table);
    const point = await makeRestorePoint(deps(), {
      userId: owner,
      baseId: named.id,
    });
    const restored = await restoreFromPoint(restoreDeps(), {
      userId: owner,
      restorePointId: point.id,
      name: "Keys (restored)",
    });
    expect(await readBack(await tableOf(restored.baseId, "Patients"))).toEqual(
      before,
    );
    const written = await snapshotOf(db, files, named.id, { withData: true });
    if (written.packed.kind !== "zip") throw new Error("not an archive");
    const staged = await stageSnapshotFile(db, files, {
      userId: owner,
      path: written.packed.path,
      size: written.packed.size,
      filename: "keys.anygriddb.zip",
    });
    const outcome = (await importJob(staged.snapshotId)) as {
      result: { baseId: string };
    };
    await written.close();
    expect(
      await readBack(await tableOf(outcome.result.baseId, "Patients")),
    ).toEqual(before);
  }, 60_000);

  it("refuses a row's place that would stop every table from taking a row", async () => {
    const plain = await exported("places");
    const count = await countBases();
    const tooFar = join(folder, "place-max.zip");
    await rewritten(plain, tooFar, {
      lines: (rows) => {
        if (rows[0]) rows[0].__position = "9223372036854775807";
      },
    });
    const staged = await stage(tooFar);
    await expect(importJob(staged.snapshotId)).rejects.toMatchObject({
      code: "invalid_snapshot",
    });
    expect(await countBases()).toBe(count);
    const { engine } = await loadEngine(db, visits, () => true);
    await expect(
      insertRows(db, engine, await context(visits, owner), [
        { label: "Another table still takes a row" },
      ]),
    ).resolves.toHaveLength(1);
  }, 60_000);
});
