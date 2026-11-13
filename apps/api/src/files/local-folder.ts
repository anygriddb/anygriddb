import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A folder of the system's temporary space for one file on its way in or
 * out (an upload, an export, a snapshot), removed with what it holds.
 * The file is written there as it comes, never held in memory whole.
 */
export async function localFolder(
  purpose: "upload" | "import" | "export" | "snapshot",
): Promise<{ path: string; remove: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), `anygriddb-${purpose}-`));
  return { path, remove: () => rm(path, { recursive: true, force: true }) };
}
