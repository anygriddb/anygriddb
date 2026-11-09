import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiskStore } from "./disk.js";
import { readFile, type FileStore } from "./store.js";
import { copyFiles } from "./transfer.js";

const job = (n: number) => `6f7d1c2a-3b4e-4f5a-8b9c-0d1e2f3a4b5${n}`;

async function store() {
  return new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-copy-")));
}

async function keysOf(files: FileStore): Promise<string[]> {
  const keys: string[] = [];
  for await (const entry of files.list()) keys.push(entry.key);
  return keys.sort();
}

describe("copyFiles", () => {
  it("copies what the target lacks, then only what was written since", async () => {
    const source = await store();
    const target = await store();
    await source.put(`exports/${job(1)}`, Buffer.from("one"), "text/csv");
    await source.put("att" + "a".repeat(32), Buffer.from("png"), "image/png");
    const errors: string[] = [];
    const onError = (key: string) => errors.push(key);

    const dry = await copyFiles(source, target, { dryRun: true, onError });
    expect(dry).toEqual({ copied: 2, skipped: 0, failed: 0, bytes: 6 });
    expect(await keysOf(target)).toEqual([]);

    expect(await copyFiles(source, target, { onError })).toEqual({
      copied: 2,
      skipped: 0,
      failed: 0,
      bytes: 6,
    });
    expect(await readFile(target, "att" + "a".repeat(32), 100)).toEqual({
      bytes: Buffer.from("png"),
      contentType: "image/png",
    });

    await source.put(`exports/${job(2)}`, Buffer.from("two"), "text/csv");
    expect(await copyFiles(source, target, { onError })).toEqual({
      copied: 1,
      skipped: 2,
      failed: 0,
      bytes: 3,
    });
    expect(await keysOf(target)).toEqual(await keysOf(source));
    // Nothing is ever deleted from the source.
    expect(await keysOf(source)).toHaveLength(3);
    expect(errors).toEqual([]);
  });

  it("reports a file it could not copy and goes on", async () => {
    const source = await store();
    const target = await store();
    const broken = `exports/${job(3)}`;
    await source.put(broken, Buffer.from("bad"), "text/csv");
    await source.put(`exports/${job(4)}`, Buffer.from("good"), "text/csv");
    const failing: FileStore = Object.assign(Object.create(target) as object, {
      putFile: (key: string, file: Parameters<FileStore["putFile"]>[1]) =>
        key === broken
          ? Promise.reject(new Error("disk full"))
          : target.putFile(key, file),
    }) as FileStore;
    const errors: Array<[string, unknown]> = [];
    const report = await copyFiles(source, failing, {
      concurrency: 1,
      onError: (key, error) => errors.push([key, error]),
    });
    expect(report).toMatchObject({ copied: 1, failed: 1 });
    expect(errors).toEqual([[broken, new Error("disk full")]]);
    expect(await keysOf(target)).toEqual([`exports/${job(4)}`]);
  });
});
