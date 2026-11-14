/**
 * A base's snapshot, written to a local folder and read back, for tests
 * that look at what it holds: its JSON, and each table's lines.
 */
import type { SnapshotLine } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { FileStore } from "../files/index.js";
import { localFolder } from "../files/local-folder.js";
import { readSnapshotLines, writeBaseSnapshot } from "./base-snapshot.js";
import { ZipReader } from "./zip.js";

export async function snapshotOf(
  db: Database,
  files: FileStore,
  baseId: string,
  input: { withData: boolean; embedFiles?: boolean; maxRows?: number },
) {
  const folder = await localFolder("snapshot");
  try {
    const written = await writeBaseSnapshot(db, files, baseId, {
      withData: input.withData,
      folder: folder.path,
      maxRows: input.maxRows ?? 1_000_000,
      ...(input.embedFiles === undefined
        ? {}
        : { embedFiles: input.embedFiles }),
    });
    const archive =
      written.packed.kind === "zip"
        ? await ZipReader.open(written.packed.path, { maxEntries: 100_000 })
        : undefined;
    const readLines = (key: string): AsyncIterable<SnapshotLine> =>
      archive
        ? readSnapshotLines(archive, key)
        : (async function* (): AsyncGenerator<SnapshotLine> {})();
    const linesOf = async (key: string): Promise<SnapshotLine[]> => {
      const out: SnapshotLine[] = [];
      for await (const line of readLines(key)) out.push(line);
      return out;
    };
    return {
      ...written,
      folder,
      archive,
      readLines,
      linesOf,
      close: folder.remove,
    };
  } catch (error) {
    await folder.remove();
    throw error;
  }
}
