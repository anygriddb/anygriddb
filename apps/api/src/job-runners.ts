import { createReadStream } from "node:fs";
import { join } from "node:path";
import {
  type Action,
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
  resolveAttachmentMaxBytes,
  roleAllows,
  roleFor,
  trashPurgeJobInputSchema,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import type { Bus } from "./realtime/bus.js";
import { cleanFilename } from "./attachments.js";
import { findLiveTable } from "./services/rows.js";
import { loadBindings } from "./auth/access.js";
import { readerEngine } from "./data/acl.js";
import { announceRows } from "./data/announce.js";
import {
  exportBaseSnapshot,
  importBaseSnapshot,
  packSnapshot,
} from "./data/base-snapshot.js";
import { duplicateTable, MAX_COPY_ROWS } from "./data/data-ops.js";
import type { TableRow } from "./data/engine.js";
import {
  dropStagedImport,
  importIntoTable,
  loadStagedImport,
} from "./data/import-commit.js";
import { liveBase } from "./data/live.js";
import { assertFieldsWritable, listCollaborators } from "./data/rows.js";
import {
  dropStagedSnapshot,
  keepStagedSnapshot,
  openStagedSnapshot,
  snapshotFolder,
} from "./data/snapshot-stage.js";
import { removeBase, removeTable } from "./data/tables.js";
import {
  baseTrashItems,
  dueTrashItems,
  itemBaseId,
  orderForPurge,
  purgeItem,
  type PurgeTarget,
} from "./data/trash.js";
import { EXPORT_MIME, exportTable } from "./data-transfer.js";
import type { JobRow, JobRunner } from "./jobs.js";
import { publishCatalog } from "./realtime/channels.js";
import { type FileStore, readFile as readStoredFile } from "./files/index.js";
import { localFolder } from "./files/local-folder.js";
import { exportKey } from "./storage.js";
import { readAirtableBase } from "./data/airtable-import.js";
import { decryptSecret } from "./auth/crypto.js";
import { madeNamesFor, readGateSettings } from "./settings.js";

export type RunnerDeps = {
  db: Database;
  bus: Bus;
  files: FileStore;
  log: (error: unknown, message: string) => void;
  /** The instance's key: it unseals a token a job carries (Airtable). */
  key?: Buffer;
  /** How Airtable is reached: `fetch`, or a stand-in in tests. */
  airtableFetch?: typeof fetch;
  /** Environment bootstrap for the attachment ceiling (ADR 0050). */
  envAttachmentMaxBytes?: number;
  /** The most rows an export job writes (`EXPORT_MAX_ROWS`). */
  exportMaxRows?: number;
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
export async function activeAuthor(
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
  return { userId: job.userId, bindings: await loadBindings(db, job.userId) };
}

export async function authorTable(
  db: Database,
  job: Pick<JobRow, "userId">,
  tableId: string,
  action: Action,
): Promise<{ userId: string; table: TableRow; bindings: Binding[] }> {
  const { userId, bindings } = await activeAuthor(db, job);
  // A table in the trash, or in a base in the trash, is gone for a job.
  const table = await findLiveTable(db, tableId);
  if (!table) throw new AppError("unknown_table");
  if (
    !roleAllows(effectiveTableRole(bindings, table.id, table.baseId), action)
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
      "write",
    );
    const staged = await loadStagedImport(
      deps.db,
      deps.files,
      input.importId,
      userId,
    );
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
    let written = 0;
    try {
      const result = await importIntoTable(deps.db, {
        userId,
        table,
        staged,
        mapping: input.mapping,
        upsertSource: input.upsertSource,
        addOptions: input.addOptions,
        canManage: roleAllows(
          effectiveTableRole(bindings, table.id, table.baseId),
          "manage",
        ),
        reason: input.reason,
        created: input.created,
        resolveUser: (text) => {
          const folded = text.trim().toLowerCase();
          return people.find(
            (person) => person.displayName.toLowerCase() === folded,
          )?.id;
        },
        onProgress: async (done, total) => {
          written = done;
          await progress(done, total);
        },
        eventKey: `job:${job.id}`,
        rowScope: engine,
      });
      await dropStagedImport(deps.db, deps.files, input.importId);
      if (input.created || result.createdColumns > 0) {
        await catalogChanged(deps, table.baseId);
      }
      return { result: { ...result } };
    } finally {
      // A cancelled import keeps the batches it wrote: tabs reload them.
      if (written > 0) {
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
      "read",
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
          maxRows: deps.exportMaxRows ?? MAX_COPY_ROWS,
          onProgress: progress,
        },
      );
      const key = exportKey(job.id);
      await deps.files.putFile(key, {
        body: createReadStream(path),
        size,
        contentType: EXPORT_MIME[input.format],
      });
      return {
        fileKey: key,
        result: {
          rows,
          format: input.format,
          filename: `${cleanFilename(table.name)}.${input.format}`,
          size,
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
      "manage",
    );
    if (!roleAllows(roleFor(bindings, "base", table.baseId), "manage")) {
      throw new AppError("access_denied");
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
      return { result: { tableId: created.id, baseId: table.baseId } };
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
      if (!roleAllows(roleFor(bindings, "base", baseId), "manage")) {
        throw new AppError("access_denied");
      }
      const items =
        input.items ?? (await baseTrashItems(deps.db, baseId, userId));
      for (const item of items) {
        if ((await itemBaseId(deps.db, item)) !== baseId) {
          throw new AppError("invalid_job");
        }
      }
      targets = orderForPurge(items).map((item) => ({
        ...item,
        actorId: userId,
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
    return { result: { purged } };
  };

const runExportSnapshot =
  (deps: RunnerDeps): JobRunner =>
  async ({ job, progress }) => {
    const input = exportSnapshotJobInputSchema.parse(job.input);
    const { bindings } = await activeAuthor(deps.db, job);
    if (!roleAllows(roleFor(bindings, "base", input.baseId), "manage")) {
      throw new AppError("access_denied");
    }
    const base = await deps.db
      .selectFrom("bases")
      .select(["id", "name"])
      .where("id", "=", input.baseId)
      .where(liveBase())
      .executeTakeFirst();
    if (!base) throw new AppError("unknown_base");
    const exported = await exportBaseSnapshot(deps.db, input.baseId, {
      withData: input.withData,
      onProgress: progress,
    });
    // There is always a file store now: disk by default (ADR 0010).
    const fileKey = exportKey(job.id);
    const folder = await snapshotFolder();
    try {
      // With files, an archive written to a local file, then streamed.
      const packed = await packSnapshot(deps.files, exported, folder.path);
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
      return {
        fileKey,
        result: {
          rows: null,
          format: packed.kind,
          filename: packed.filename,
          size,
          files: exported.attachments.size,
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
    const opened = await openStagedSnapshot(
      deps.db,
      deps.files,
      input.snapshotId,
      userId,
    );
    await keepStagedSnapshot(deps.db, input.snapshotId);
    let baseId: string | undefined;
    try {
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
      if (!input.token || !deps.key)
        throw new AppError("airtable_unauthorized");
      const token = decryptSecret(
        Buffer.from(input.token.ciphertext, "base64"),
        Buffer.from(input.token.nonce, "base64"),
        deps.key,
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
    if (!roleAllows(roleFor(bindings, "base", input.baseId), "manage")) {
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
    const { snapshot } = await exportBaseSnapshot(deps.db, input.baseId, {
      withData: input.withData,
      onProgress: half(0),
    });
    let baseId: string | undefined;
    try {
      const created = await importBaseSnapshot(
        deps.db,
        deps.files,
        userId,
        snapshot,
        {
          name: input.name,
          onCreated: (id) => {
            baseId = id;
          },
          onProgress: half(DUPLICATE_SCALE / 2),
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
    }
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
  };
}
