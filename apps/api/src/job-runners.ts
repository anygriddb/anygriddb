import type { KeyRing } from "./auth/key-ring.js";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import {
  type Permission,
  airtableToSnapshot,
  AppError,
  type Binding,
  duplicateBaseJobInputSchema,
  duplicateJobInputSchema,
  effectiveTableRole,
  exportJobInputSchema,
  exportSnapshotJobInputSchema,
  importJobInputSchema,
  importAirtableJobInputSchema,
  importSnapshotJobInputSchema,
  type JobKind,
  MAX_SNAPSHOT_TABLES,
  resolveAttachmentMaxBytes,
  importWorkbookJobInputSchema,
  accountExportJobInputSchema,
  convertColumnJobInputSchema,
  restoreBaseJobInputSchema,
  restorePointJobInputSchema,
  type Grant,
  roleFor,
  roleGrants,
  trashPurgeJobInputSchema,
} from "@anygriddb/core";
import {
  type Declaration,
  demand,
  granted,
  holds,
} from "./access/declaration.js";
import { loadInstanceFlags } from "./auth/instance-roles.js";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import type { Bus } from "./realtime/bus.js";
import { cleanFilename } from "./attachments.js";
import { findLiveTable } from "./services/rows.js";
import { loadBindings } from "./auth/access.js";
import { openBaseIds, withOpenBases } from "./data/emergency-access.js";
import { readerEngine, readerRulesPrint } from "./data/acl.js";
import { announceRows } from "./data/announce.js";
import { runConversion } from "./data/conversion-job.js";
import {
  importBaseSnapshot,
  readSnapshotComments,
  readSnapshotLines,
  writeBaseSnapshot,
} from "./data/base-snapshot.js";
import { assertMayCopyRows, duplicateTable } from "./data/data-ops.js";
import type { TableRow } from "./data/engine.js";
import {
  copyStagedImport,
  dropStagedImport,
  IMPORT_BATCH,
  type ImportSource,
  importIntoTable,
  loadStagedImport,
} from "./data/import-commit.js";
import { liveBase } from "./data/live.js";
import { assertFieldsWritable, listCollaborators } from "./data/rows.js";
import {
  dropStagedSnapshot,
  keepStagedSnapshot,
  openStagedSnapshot,
} from "./data/snapshot-stage.js";
import {
  findRestorePoint,
  makeRestorePoint,
  purgeRestorePoints,
  restoreFromPoint,
} from "./data/restore-points.js";
import { removeBase, removeTable } from "./data/tables.js";
import { dropStagedWorkbook, importWorkbook } from "./data/workbook-import.js";
import {
  baseTrashItems,
  dueTrashItems,
  itemBaseId,
  orderForPurge,
  purgeItem,
  type PurgeTarget,
} from "./data/trash.js";
import { recordExport } from "./data/export-audit.js";
import { EXPORT_MIME, exportTable } from "./data-transfer.js";
import {
  JobCancelled,
  type JobRow,
  type JobRunner,
  JobStoppedAfter,
} from "./jobs.js";
import { publishCatalog } from "./realtime/channels.js";
import { type FileStore, readFile as readStoredFile } from "./files/index.js";
import { localFolder } from "./files/local-folder.js";
import { ZipReader } from "./data/zip.js";
import { readImportFileIsolated } from "./import-isolated.js";
import { exportKey } from "./storage.js";
import { readAirtableBase } from "./data/airtable-import.js";
import { decryptSecret } from "./auth/crypto.js";
import { madeNamesFor, readGateSettings } from "./settings.js";
import {
  exportCeiling,
  importCeiling,
  type RowsFixed,
} from "./row-ceilings.js";
import { writeAccountDataFile } from "./data/account-export.js";
import { recordAuthEvent } from "./auth/auth-events.js";

type RunnerDeps = {
  db: Database;
  bus: Bus;
  files: FileStore;
  log: (error: unknown, message: string) => void;
  /** The instance's key: it unseals a token a job carries (Airtable). */
  key?: KeyRing;
  /** How Airtable is reached: `fetch`, or a stand-in in tests. */
  airtableFetch?: typeof fetch;
  /** The environment's attachment ceiling: it wins when set (ADR 0083). */
  envAttachmentMaxBytes?: number;
  /** The rows of a file the environment fixes: they win when set (ADR 0083). */
  rowsFixed?: RowsFixed;
};

async function attachmentCeiling(deps: RunnerDeps): Promise<number> {
  return resolveAttachmentMaxBytes(
    await readGateSettings(deps.db),
    deps.envAttachmentMaxBytes,
  );
}

/**
 * The author's current rights on the job's table. A job queued by
 * someone who has since lost access, or whose account was disabled,
 * stops here.
 */
async function activeAuthor(
  db: Database,
  job: Pick<JobRow, "userId">,
): Promise<{ userId: string; bindings: Binding[] }> {
  if (!job.userId) throw new AppError("access_denied");
  const author = await db
    .selectFrom("users")
    .select("disabledAt")
    .where("id", "=", job.userId)
    .executeTakeFirst();
  if (!author || author.disabledAt) throw new AppError("access_denied");
  // A job is what its author asked for from their own session: it reads
  // the bases they have open as an administrator, as their pages do, and
  // only while the opening lasts (ADR 0074).
  return {
    userId: job.userId,
    bindings: withOpenBases(
      await loadBindings(db, job.userId),
      await openBaseIds(db, job.userId),
    ),
  };
}

/**
 * A job that makes a base asks, as it runs, what making one asks then: an
 * instance that keeps bases to its administrators refuses anyone else.
 */
async function assertMayMakeBase(db: Database, userId: string): Promise<void> {
  if ((await readGateSettings(db)).baseCreation !== "admins") return;
  if (!holds(await loadInstanceFlags(db, userId), "bases.create")) {
    throw new AppError("base_creation_restricted");
  }
}

/** A base's snapshot carries its rows: the base's and an export. */
function canSnapshot(role: Grant | null): boolean {
  return granted(role, "base.manage") && granted(role, "data.export");
}

export async function authorTable(
  db: Database,
  job: Pick<JobRow, "userId">,
  tableId: string,
  permission: Permission,
): Promise<{ userId: string; table: TableRow; bindings: Binding[] }> {
  const { userId, bindings } = await activeAuthor(db, job);
  // A table in the trash, or in a base in the trash, is gone for a job.
  const table = await findLiveTable(db, tableId);
  if (!table) throw new AppError("unknown_table");
  if (
    !granted(effectiveTableRole(bindings, table.id, table.baseId), permission)
  ) {
    throw new AppError("access_denied");
  }
  return { userId, table, bindings };
}

function catalogChanged(deps: RunnerDeps, baseId: string): Promise<void> {
  return publishCatalog(deps.bus, baseId, (error) =>
    deps.log(error, "realtime publish failed"),
  );
}

const runImport =
  (deps: RunnerDeps): JobRunner =>
  async ({ job, progress }) => {
    const input = importJobInputSchema.parse(job.input);
    const { userId, table, bindings } = await authorTable(
      deps.db,
      job,
      input.tableId,
      "data.import",
    );
    const staged = await loadStagedImport(deps.db, input.importId, userId);
    // Field and row rules may have changed since the job was queued.
    const { engine } = await readerEngine(deps.db, table.id, {
      userId,
      bindings,
    });
    assertFieldsWritable(
      engine,
      input.mapping.flatMap((entry) => (entry.column ? [entry.column] : [])),
    );
    const people = await listCollaborators(deps.db, table.baseId);
    const folder = await localFolder("import");
    let read = 0;
    let written = { inserted: 0, updated: 0 };
    try {
      // The file is read from local disk as rows are written (ADR 0064).
      const path = join(folder.path, "upload");
      await copyStagedImport(deps.db, deps.files, staged, path);
      const maxRows = await importCeiling(deps.db, deps.rowsFixed);
      const source: ImportSource = {
        headers: staged.shape.headers,
        total: staged.shape.total,
        batches: () =>
          readImportFileIsolated(staged.shape, path, IMPORT_BATCH, maxRows),
      };
      const result = await importIntoTable(deps.db, {
        userId,
        table,
        source,
        mapping: input.mapping,
        upsertSource: input.upsertSource,
        addOptions: input.addOptions,
        canManage: roleGrants(
          effectiveTableRole(bindings, table.id, table.baseId),
          "schema.manage",
        ),
        reason: input.reason,
        created: input.created,
        ...(input.decimalMark ? { decimalMark: input.decimalMark } : {}),
        ...(input.dayOrder ? { dayOrder: input.dayOrder } : {}),
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
        resolveUser: (text) => {
          const folded = text.trim().toLowerCase();
          return people.find(
            (person) => person.displayName.toLowerCase() === folded,
          )?.id;
        },
        onProgress: async (done, total) => {
          read = done;
          await progress(done, total);
        },
        onWritten: (counts) => {
          written = counts;
        },
        ...(input.stripTextGuard ? { stripTextGuard: true } : {}),
        eventKey: `job:${job.id}`,
        rowScope: engine,
      });
      await dropStagedImport(deps.db, deps.files, input.importId);
      if (input.created || result.createdColumns > 0) {
        await catalogChanged(deps, table.baseId);
      }
      return { result: { ...result } };
    } catch (error) {
      // Each batch commits alone: a failure says what is already in.
      if (
        error instanceof JobCancelled ||
        written.inserted + written.updated === 0
      ) {
        throw error;
      }
      throw new JobStoppedAfter(error, { ...written });
    } finally {
      await folder.remove();
      // A cancelled import keeps the batches it wrote: tabs reload them.
      if (read > 0) {
        await announceRows(deps, table.id, "refresh", []);
      }
    }
  };

const runExport =
  (deps: RunnerDeps): JobRunner =>
  async ({ job, progress }) => {
    const input = exportJobInputSchema.parse(job.input);
    const { userId, table, bindings } = await authorTable(
      deps.db,
      job,
      input.tableId,
      "data.export",
    );
    // Taken before the rows: a rule changed while they are read refuses
    // the file rather than serving what it now hides.
    const rulesPrint = await readerRulesPrint(
      deps.db,
      { userId, bindings },
      table.id,
    );
    // Written to a local file as the rows are read, then streamed to the
    // store: no page is held once written.
    const folder = await localFolder("export");
    try {
      const path = join(folder.path, "export");
      const { rows, size } = await exportTable(
        deps,
        { userId, bindings },
        table,
        input,
        {
          path,
          maxRows: await exportCeiling(deps.db, deps.rowsFixed),
          onProgress: progress,
        },
      );
      const key = exportKey(job.id);
      await deps.files.putFile(key, {
        body: createReadStream(path),
        size,
        contentType: EXPORT_MIME[input.format],
      });
      await recordExport(deps.db, {
        userId,
        tableId: table.id,
        source: "web",
        export: {
          kind: "view",
          format: input.format,
          rows,
          ...(input.viewId ? { viewId: input.viewId } : {}),
        },
      });
      return {
        fileKey: key,
        result: {
          rows,
          format: input.format,
          filename: `${cleanFilename(table.name)}.${input.format}`,
          size,
          ...(rulesPrint ? { rulesPrint } : {}),
        },
      };
    } finally {
      await folder.remove();
    }
  };

const runDuplicate =
  (deps: RunnerDeps): JobRunner =>
  async ({ job, progress }) => {
    const input = duplicateJobInputSchema.parse(job.input);
    const { userId, table, bindings } = await authorTable(
      deps.db,
      job,
      input.tableId,
      "schema.manage",
    );
    demand(roleFor(bindings, "base", table.baseId), "schema.manage");
    if (input.withData) {
      assertMayCopyRows({ userId, bindings }, table);
    }
    let copyId: string | undefined;
    try {
      const created = await duplicateTable(deps.db, userId, table, {
        name: input.name,
        withData: input.withData,
        onCreated: (id) => {
          copyId = id;
        },
        onProgress: progress,
      });
      await catalogChanged(deps, table.baseId);
      return {
        result: {
          tableId: created.id,
          baseId: table.baseId,
          ...(created.signaturesLeft
            ? { report: { signaturesLeft: created.signaturesLeft } }
            : {}),
        },
      };
    } catch (error) {
      // A half-made copy would only confuse: it goes away with the job.
      if (copyId) {
        await removeTable(deps.db, deps.files, userId, copyId, (cause) =>
          deps.log(cause, "attachment delete failed"),
        ).catch((cause: unknown) =>
          deps.log(cause, "partial copy cleanup failed"),
        );
        await catalogChanged(deps, table.baseId);
      }
      throw error;
    }
  };

/**
 * Empties chosen items, or a whole base's trash, for an author who still
 * manages the base; or, as a system job, purges what the trash no longer keeps.
 */
const runTrashPurge =
  (deps: RunnerDeps): JobRunner =>
  async ({ job, progress }) => {
    const input = trashPurgeJobInputSchema.parse(job.input);
    let targets: PurgeTarget[];
    if (input.due) {
      if (job.userId) throw new AppError("access_denied");
      targets = await dueTrashItems(deps.db, new Date());
    } else {
      const baseId = input.baseId;
      if (!baseId) throw new AppError("invalid_job");
      const { userId, bindings } = await activeAuthor(deps.db, job);
      demand(roleFor(bindings, "base", baseId), "base.manage");
      const items =
        input.items ?? (await baseTrashItems(deps.db, baseId, userId));
      for (const item of items) {
        if ((await itemBaseId(deps.db, item)) !== baseId) {
          throw new AppError("invalid_job");
        }
      }
      if (
        input.dropSchema &&
        !holds(await loadInstanceFlags(deps.db, userId), "bases.oversee")
      ) {
        throw new AppError("access_denied");
      }
      targets = orderForPurge(items).map((item) => ({
        ...item,
        actorId: userId,
        ...(input.dropSchema && item.kind === "base" && item.id === baseId
          ? { dropSchema: input.dropSchema }
          : {}),
      }));
    }
    await progress(0, targets.length);
    let purged = 0;
    const bases = new Set<string>();
    for (const [index, target] of targets.entries()) {
      const baseId = await itemBaseId(deps.db, target);
      if (await purgeItem(deps, target)) {
        purged += 1;
        if (baseId) bases.add(baseId);
      }
      await progress(index + 1, targets.length);
    }
    for (const baseId of bases) await catalogChanged(deps, baseId);
    // The nightly purge also removes the restore points past their date.
    if (input.due) {
      await purgeRestorePoints(deps.db, deps.files, (cause) =>
        deps.log(cause, "restore point file delete failed"),
      );
    }
    return { result: { purged } };
  };

/**
 * A restore point of a base (ADR 0077): its snapshot with its data and
 * files, kept in the store and listed on the base until its date passes.
 */
const runRestorePoint =
  (deps: RunnerDeps): JobRunner =>
  async ({ job, progress }) => {
    const input = restorePointJobInputSchema.parse(job.input);
    const { userId, bindings } = await activeAuthor(deps.db, job);
    demand(roleFor(bindings, "base", input.baseId), "base.manage");
    const made = await makeRestorePoint(
      {
        db: deps.db,
        files: deps.files,
        maxRows: await exportCeiling(deps.db, deps.rowsFixed),
      },
      {
        userId,
        baseId: input.baseId,
        ...(input.note ? { note: input.note } : {}),
        onProgress: progress,
      },
    );
    return {
      result: {
        restorePointId: made.id,
        baseId: input.baseId,
        rows: made.rows,
        size: made.size,
        files: made.files,
      },
    };
  };

/**
 * A base read back from one of its restore points, as a new base: the
 * person who asks manages the base it was made of.
 */
const runRestoreBase =
  (deps: RunnerDeps): JobRunner =>
  async ({ job, progress }) => {
    const input = restoreBaseJobInputSchema.parse(job.input);
    const { userId, bindings } = await activeAuthor(deps.db, job);
    const point = await findRestorePoint(deps.db, input.restorePointId);
    // Its rows come back in a new base its author owns: an export.
    if (
      !["base.manage" as const, "data.export" as const].every((asked) =>
        granted(roleFor(bindings, "base", point.baseId), asked),
      )
    ) {
      throw new AppError("access_denied");
    }
    let baseId: string | undefined;
    try {
      const created = await restoreFromPoint(
        {
          db: deps.db,
          files: deps.files,
          maxRows: await importCeiling(deps.db, deps.rowsFixed),
          maxFileBytes: await attachmentCeiling(deps),
          names: await madeNamesFor(deps.db),
        },
        {
          userId,
          restorePointId: input.restorePointId,
          ...(input.name ? { name: input.name } : {}),
          onCreated: (id) => {
            baseId = id;
          },
          onProgress: progress,
        },
      );
      await catalogChanged(deps, created.baseId);
      return { result: { baseId: created.baseId, report: created.report } };
    } catch (error) {
      if (baseId) {
        await removeBase(deps.db, deps.files, userId, baseId, (cause) =>
          deps.log(cause, "restore cleanup failed"),
        ).catch((cause: unknown) =>
          deps.log(cause, "partial restore cleanup failed"),
        );
      }
      throw error;
    }
  };

const runExportSnapshot =
  (deps: RunnerDeps): JobRunner =>
  async ({ job, progress }) => {
    const input = exportSnapshotJobInputSchema.parse(job.input);
    const { userId, bindings } = await activeAuthor(deps.db, job);
    if (!canSnapshot(roleFor(bindings, "base", input.baseId))) {
      throw new AppError("access_denied");
    }
    const base = await deps.db
      .selectFrom("bases")
      .select(["id", "name"])
      .where("id", "=", input.baseId)
      .where(liveBase())
      .executeTakeFirst();
    if (!base) throw new AppError("unknown_base");
    // There is always a file store now: disk by default (ADR 0010).
    const fileKey = exportKey(job.id);
    const folder = await localFolder("snapshot");
    try {
      // With data, an archive written to a local file as the rows are
      // read, then streamed to the store.
      const written = await writeBaseSnapshot(
        deps.db,
        deps.files,
        input.baseId,
        {
          withData: input.withData,
          folder: folder.path,
          maxRows: await exportCeiling(deps.db, deps.rowsFixed),
          onProgress: progress,
        },
      );
      const packed = written.packed;
      let size: number;
      if (packed.kind === "json") {
        await deps.files.put(
          fileKey,
          packed.bytes,
          "application/json; charset=utf-8",
        );
        size = packed.bytes.length;
      } else {
        await deps.files.putFile(fileKey, {
          body: createReadStream(packed.path),
          size: packed.size,
          contentType: "application/zip",
        });
        size = packed.size;
      }
      await recordExport(deps.db, {
        userId,
        source: "web",
        export: { kind: "base", format: packed.kind, baseId: base.id },
      });
      return {
        fileKey,
        result: {
          rows: written.rows,
          format: packed.kind,
          filename: packed.filename,
          size,
          files: written.files,
          baseId: base.id,
          baseName: base.name,
        },
      };
    } finally {
      await folder.remove();
    }
  };

const runImportSnapshot =
  (deps: RunnerDeps): JobRunner =>
  async ({ job, progress }) => {
    const input = importSnapshotJobInputSchema.parse(job.input);
    const { userId } = await activeAuthor(deps.db, job);
    await assertMayMakeBase(deps.db, userId);
    const opened = await openStagedSnapshot(
      deps.db,
      deps.files,
      input.snapshotId,
      userId,
    );
    await keepStagedSnapshot(deps.db, input.snapshotId);
    let baseId: string | undefined;
    try {
      // The whole file first: a damaged one makes no base at all.
      await opened.verify(() => progress(0, null));
      const created = await importBaseSnapshot(
        deps.db,
        deps.files,
        userId,
        opened.snapshot,
        {
          name: input.name,
          onCreated: (id) => {
            baseId = id;
          },
          onProgress: progress,
          restoreMembers: input.restoreMembers,
          readFile: opened.readFile,
          readLines: opened.readLines,
          maxRows: await importCeiling(deps.db, deps.rowsFixed),
          maxFileBytes: await attachmentCeiling(deps),
          names: await madeNamesFor(deps.db),
        },
      );
      await catalogChanged(deps, created.baseId);
      return { result: { baseId: created.baseId, report: created.report } };
    } catch (error) {
      if (baseId) {
        await removeBase(deps.db, deps.files, userId, baseId, (cause) =>
          deps.log(cause, "snapshot cleanup failed"),
        ).catch((cause: unknown) =>
          deps.log(cause, "partial snapshot cleanup failed"),
        );
      }
      throw error;
    } finally {
      await opened.close();
      await dropStagedSnapshot(deps.db, deps.files, input.snapshotId);
    }
  };

/**
 * A workbook as a new base (ADR 0078): a table for each chosen sheet,
 * its rows written as they are read. A failure, or a cancel, removes the
 * base begun; the staged file goes however the job ends.
 */
const runImportWorkbook =
  (deps: RunnerDeps): JobRunner =>
  async ({ job, progress }) => {
    const input = importWorkbookJobInputSchema.parse(job.input);
    const { userId } = await activeAuthor(deps.db, job);
    await assertMayMakeBase(deps.db, userId);
    let baseId: string | undefined;
    try {
      const made = await importWorkbook(
        {
          db: deps.db,
          files: deps.files,
          maxRows: await importCeiling(deps.db, deps.rowsFixed),
          names: await madeNamesFor(deps.db),
        },
        {
          userId,
          importId: input.importId,
          name: input.name,
          sheets: input.sheets,
          eventKey: `job:${job.id}`,
          onCreated: (id) => {
            baseId = id;
          },
          onProgress: progress,
        },
      );
      await catalogChanged(deps, made.baseId);
      return { result: { baseId: made.baseId, report: made.report } };
    } catch (error) {
      if (baseId) {
        await removeBase(deps.db, deps.files, userId, baseId, (cause) =>
          deps.log(cause, "workbook cleanup failed"),
        ).catch((cause: unknown) =>
          deps.log(cause, "partial workbook cleanup failed"),
        );
      }
      throw error;
    } finally {
      await dropStagedWorkbook(deps.db, deps.files, input.importId);
    }
  };

/**
 * An Airtable base as a new base: read through Airtable's Web API with
 * the token its author gave, converted to a snapshot, built by the
 * snapshot import. The report names what did not come over as it was.
 * The token leaves the job's input when the job ends, however it ends.
 */
const runImportAirtable =
  (deps: RunnerDeps): JobRunner =>
  async ({ job, progress }) => {
    const input = importAirtableJobInputSchema.parse(job.input);
    try {
      const { userId } = await activeAuthor(deps.db, job);
      await assertMayMakeBase(deps.db, userId);
      if (!input.token || !deps.key)
        throw new AppError("airtable_unauthorized");
      const token = decryptSecret(
        Buffer.from(input.token.ciphertext, "base64"),
        Buffer.from(input.token.nonce, "base64"),
        deps.key,
        "job-token",
      );
      // One scale for both phases, so the bar never steps back: reading
      // fills [0, 500], building [500, 1000], each by its own share done.
      const share = (offset: number, done: number, total: number | null) =>
        progress(
          offset + Math.round(500 * Math.min(1, total ? done / total : 0)),
          1_000,
        );
      const airtable = await readAirtableBase(token, input.airtableBaseId, {
        onProgress: (done, total) => share(0, done, total),
        ...(deps.airtableFetch ? { fetcher: deps.airtableFetch } : {}),
      });
      const names = await madeNamesFor(deps.db);
      const { snapshot, report } = airtableToSnapshot({
        name: input.name ?? "Airtable",
        tables: airtable.tables,
        records: airtable.records,
        names,
      });
      let baseId: string | undefined;
      try {
        const created = await importBaseSnapshot(
          deps.db,
          deps.files,
          userId,
          snapshot,
          {
            ...(input.name ? { name: input.name } : {}),
            onCreated: (id) => {
              baseId = id;
            },
            onProgress: (done, total) => share(500, done, total),
            maxRows: await importCeiling(deps.db, deps.rowsFixed),
            names,
          },
        );
        await catalogChanged(deps, created.baseId);
        return {
          result: {
            baseId: created.baseId,
            tables: snapshot.tables.length,
            rows: snapshot.tables.reduce(
              (sum, table) => sum + (table.rows?.length ?? 0),
              0,
            ),
            report: report.slice(0, 500),
          },
        };
      } catch (error) {
        if (baseId) {
          await removeBase(deps.db, deps.files, userId, baseId, (cause) =>
            deps.log(cause, "airtable cleanup failed"),
          ).catch((cause: unknown) =>
            deps.log(cause, "partial airtable cleanup failed"),
          );
        }
        throw error;
      }
    } finally {
      await deps.db
        .updateTable("jobs")
        .set({ input: sql`input - 'token'` })
        .where("id", "=", job.id)
        .execute();
    }
  };

/** Units of a base copy's progress: reading, then writing, half each. */
const DUPLICATE_SCALE = 1_000;

/**
 * Copies a base for an author who still manages it: its snapshot, read
 * into a new base, with the files its cells name, read straight from the
 * store. People in user cells stay when they are members of the copy,
 * which starts with its author alone: giving the original's members their
 * roles back would skip its table roles and field rules. A half-made copy
 * goes away with the job.
 */
const runDuplicateBase =
  (deps: RunnerDeps): JobRunner =>
  async ({ job, progress }) => {
    const input = duplicateBaseJobInputSchema.parse(job.input);
    const { userId, bindings } = await activeAuthor(deps.db, job);
    // A copy with its rows is the base's and an export, as its snapshot is.
    if (
      !(
        input.withData
          ? (["base.manage", "data.export"] as const)
          : (["base.manage"] as const)
      ).every((asked) =>
        granted(roleFor(bindings, "base", input.baseId), asked),
      )
    ) {
      throw new AppError("access_denied");
    }
    // Reading the base is the first half of the work, writing the copy
    // the second; each counts in its own units, so both report a share.
    const half =
      (offset: number) =>
      (done: number, total: number | null): Promise<void> =>
        total === null || total <= 0
          ? progress(offset, DUPLICATE_SCALE)
          : progress(
              offset +
                Math.round(
                  ((DUPLICATE_SCALE / 2) * Math.min(done, total)) / total,
                ),
              DUPLICATE_SCALE,
            );
    // The copy is a snapshot written to a local file and read back, its
    // files left in the store, where both bases find them by their key.
    const maxRows = Math.min(
      await exportCeiling(deps.db, deps.rowsFixed),
      await importCeiling(deps.db, deps.rowsFixed),
    );
    const folder = await localFolder("snapshot");
    let baseId: string | undefined;
    try {
      const written = await writeBaseSnapshot(
        deps.db,
        deps.files,
        input.baseId,
        {
          withData: input.withData,
          folder: folder.path,
          maxRows,
          embedFiles: false,
          keepRowState: true,
          onProgress: half(0),
        },
      );
      const archive =
        written.packed.kind === "zip"
          ? await ZipReader.open(written.packed.path, {
              // Each table's rows, and its comments.
              maxEntries: 2 * MAX_SNAPSHOT_TABLES + 1,
            })
          : undefined;
      const created = await importBaseSnapshot(
        deps.db,
        deps.files,
        userId,
        written.snapshot,
        {
          name: input.name,
          onCreated: (id) => {
            baseId = id;
          },
          onProgress: half(DUPLICATE_SCALE / 2),
          ...(archive
            ? {
                readLines: (key: string) =>
                  readSnapshotLines(archive, key, { own: true }),
                readComments: (key: string) =>
                  readSnapshotComments(archive, key),
              }
            : {}),
          keepRowState: true,
          maxRows,
          // The snapshot names each file by its key in this store.
          readFile: async (key, maxBytes) =>
            (await readStoredFile(deps.files, key, maxBytes))?.bytes,
          maxFileBytes: await attachmentCeiling(deps),
          names: await madeNamesFor(deps.db),
        },
      );
      await catalogChanged(deps, created.baseId);
      return { result: { baseId: created.baseId, report: created.report } };
    } catch (error) {
      if (baseId) {
        await removeBase(deps.db, deps.files, userId, baseId, (cause) =>
          deps.log(cause, "duplicate cleanup failed"),
        ).catch((cause: unknown) =>
          deps.log(cause, "partial duplicate cleanup failed"),
        );
      }
      throw error;
    } finally {
      await folder.remove();
    }
  };

const runAccountExport =
  (deps: RunnerDeps): JobRunner =>
  async ({ job, progress }) => {
    const input = accountExportJobInputSchema.parse(job.input);
    const { userId: actorId } = await activeAuthor(deps.db, job);
    const admin = await loadInstanceFlags(deps.db, actorId);
    if (!holds(admin, "accounts.control") || admin.disabledAt !== null) {
      throw new AppError("access_denied");
    }
    const folder = await localFolder("export");
    try {
      const path = join(folder.path, "account.json");
      const written = await writeAccountDataFile(
        deps.db,
        input.userId,
        path,
        progress,
      );
      const fileKey = exportKey(job.id);
      await deps.files.putFile(fileKey, {
        body: createReadStream(path),
        size: written.size,
        contentType: "application/json; charset=utf-8",
      });
      await recordAuthEvent(deps.db, {
        action: "account_data_exported",
        userId: input.userId,
        actorId,
        method: "admin",
      });
      const filename = `account-export-${cleanFilename(written.displayName)}.json`;
      return {
        fileKey,
        result: {
          format: "json",
          filename,
          size: written.size,
          userId: input.userId,
          writes: written.counts.writes,
          comments: written.counts.comments,
          accountEvents: written.counts.signIns,
        },
      };
    } finally {
      await folder.remove();
    }
  };

/** A field of a large table converted by batches (ADR 0116). */
const runConvertColumn =
  (deps: RunnerDeps): JobRunner =>
  async ({ job, progress }) => {
    const input = convertColumnJobInputSchema.parse(job.input);
    const { userId, table } = await authorTable(
      deps.db,
      job,
      input.tableId,
      "schema.manage",
    );
    const { converted, lost } = await runConversion(deps.db, {
      userId,
      table,
      job,
      progress,
    });
    await catalogChanged(deps, table.baseId);
    return { result: { tableId: table.id, converted, lost } };
  };

/**
 * What each kind of job asks of its author when it runs, as their roles
 * stand then: a job that may no longer run ends refused.
 */
export const JOB_ASKS: Record<JobKind, Declaration> = {
  import: { asks: ["data.import"], also: ["schema.manage"] },
  export: { asks: ["data.export"] },
  duplicate_table: { asks: ["schema.manage"], also: ["data.export"] },
  trash_purge: {
    exception: "instance",
    also: ["base.manage", "bases.oversee"],
  },
  export_snapshot: { asks: ["base.manage", "data.export"] },
  import_snapshot: { asks: ["bases.create"] },
  import_airtable: { asks: ["bases.create"] },
  duplicate_base: { asks: ["base.manage"], also: ["data.export"] },
  restore_point: { asks: ["base.manage"] },
  restore_base: { asks: ["base.manage", "data.export"] },
  import_workbook: { asks: ["bases.create"] },
  account_export: { asks: ["accounts.control"] },
  convert_column: { asks: ["schema.manage"] },
};

export function jobRunners(deps: RunnerDeps): Record<JobKind, JobRunner> {
  return {
    import: runImport(deps),
    export: runExport(deps),
    duplicate_table: runDuplicate(deps),
    trash_purge: runTrashPurge(deps),
    export_snapshot: runExportSnapshot(deps),
    import_snapshot: runImportSnapshot(deps),
    import_airtable: runImportAirtable(deps),
    duplicate_base: runDuplicateBase(deps),
    restore_point: runRestorePoint(deps),
    restore_base: runRestoreBase(deps),
    import_workbook: runImportWorkbook(deps),
    account_export: runAccountExport(deps),
    convert_column: runConvertColumn(deps),
  };
}
