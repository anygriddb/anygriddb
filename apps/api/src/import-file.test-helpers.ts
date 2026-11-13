import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImportFormat } from "@anygriddb/core";
import {
  type ImportPreview,
  readImportFile,
  scanImportFile,
  type SheetRow,
  type SheetShape,
} from "./import-file.js";

/** Writes `bytes` to a file of its own and runs `use` on its path. */
export async function onDisk<T>(
  bytes: Buffer | string,
  use: (path: string) => Promise<T>,
): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), "anygriddb-import-test-"));
  try {
    const path = join(folder, "file");
    await writeFile(path, bytes);
    return await use(path);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Both passes over a file, in this thread: what an import reads of it. */
export function readImport(
  format: ImportFormat,
  bytes: Buffer | string,
  options: { maxRows?: number; batch?: number } = {},
): Promise<{ shape: SheetShape; preview: ImportPreview; rows: SheetRow[] }> {
  const maxRows = options.maxRows ?? 1_000_000;
  return onDisk(bytes, async (path) => {
    const { shape, preview } = await scanImportFile(format, path, maxRows);
    const rows: SheetRow[] = [];
    for await (const batch of readImportFile(
      shape,
      path,
      options.batch ?? 2,
      maxRows,
    )) {
      rows.push(...batch);
    }
    return { shape, preview, rows };
  });
}

/** The cells of the rows read, without their lines. */
export function cellsOf(rows: readonly SheetRow[]): string[][] {
  return rows.map((row) => row.cells);
}
