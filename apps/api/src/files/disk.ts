import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  assertFileKey,
  exactBytes,
  FILE_KEY,
  type FileEntry,
  type FileStore,
  type StoredFile,
} from "./store.js";
import { AppError } from "@anygriddb/core";

const TYPE_SUFFIX = ".type";
const TEMP_MARK = ".tmp-";

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * Files under one folder, which a volume or a NAS mount provides. Writes
 * go to a temporary file, are flushed, then renamed into place, so a crash
 * never leaves half a file under its real name. The content type sits next
 * to each file in a small `.type` file.
 */
export class DiskStore implements FileStore {
  readonly driver = "disk" as const;
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathOf(key: string): string {
    assertFileKey(key);
    const path = resolve(this.root, key);
    // FILE_KEY already forbids dots and slashes but one; check anyway.
    if (!path.startsWith(this.root + sep)) throw new AppError("invalid_file");
    return path;
  }

  /** Writes a temporary file, syncs it, then renames it to `path`. */
  private async writeAtomic(
    path: string,
    write: (handle: FileHandle) => Promise<void>,
  ): Promise<void> {
    const temporary = `${path}${TEMP_MARK}${randomBytes(6).toString("hex")}`;
    const handle = await open(temporary, "wx", 0o640);
    let renamed = false;
    try {
      try {
        await write(handle);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      renamed = true;
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }
  }

  private async prepare(key: string, contentType: string): Promise<string> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o750 });
    await this.writeAtomic(`${path}${TYPE_SUFFIX}`, (handle) =>
      handle.writeFile(contentType),
    );
    return path;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const path = await this.prepare(key, contentType);
    await this.writeAtomic(path, (handle) => handle.writeFile(body));
  }

  async putFile(key: string, file: StoredFile): Promise<void> {
    const path = await this.prepare(key, file.contentType);
    await this.writeAtomic(path, (handle) =>
      handle.writeFile(exactBytes(file.body, file.size)),
    );
  }

  async open(key: string) {
    const path = this.pathOf(key);
    try {
      const info = await stat(path);
      const contentType = await readFile(`${path}${TYPE_SUFFIX}`, "utf8").catch(
        () => "application/octet-stream",
      );
      return {
        body: createReadStream(path),
        contentType: contentType.trim() || "application/octet-stream",
        size: info.size,
      };
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathOf(key);
    await rm(path, { force: true });
    await rm(`${path}${TYPE_SUFFIX}`, { force: true });
  }

  /** Every regular file under the root, with its path relative to it. */
  private async *walk(
    folder = this.root,
  ): AsyncIterable<{ path: string; name: string }> {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) yield* this.walk(path);
      else if (entry.isFile())
        yield { path, name: relative(this.root, path).split(sep).join("/") };
    }
  }

  async *list(): AsyncIterable<FileEntry> {
    for await (const { path, name } of this.walk()) {
      if (!FILE_KEY.test(name)) continue;
      try {
        const info = await stat(path);
        yield { key: name, size: info.size, modifiedAt: info.mtime };
      } catch (error) {
        // Deleted while the listing ran.
        if (!missing(error)) throw error;
      }
    }
  }

  async tidy(before: Date): Promise<number> {
    let removed = 0;
    for await (const { path, name } of this.walk()) {
      const temporary = name.includes(TEMP_MARK);
      // A type file whose file never arrived, or was deleted without it.
      const strayType =
        name.endsWith(TYPE_SUFFIX) &&
        FILE_KEY.test(name.slice(0, -TYPE_SUFFIX.length)) &&
        !(await stat(path.slice(0, -TYPE_SUFFIX.length)).catch(() => null));
      if (!temporary && !strayType) continue;
      const info = await stat(path).catch(() => null);
      if (!info || info.mtime >= before) continue;
      await rm(path, { force: true });
      removed += 1;
    }
    return removed;
  }

  async check(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o750 });
    const probe = join(
      this.root,
      `.probe${TEMP_MARK}${randomBytes(4).toString("hex")}`,
    );
    await this.writeAtomic(probe, (handle) => handle.writeFile("ok"));
    await rm(probe, { force: true });
  }
}
