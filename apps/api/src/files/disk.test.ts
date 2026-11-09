import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { DiskStore } from "./disk.js";
import { readFile } from "./store.js";

const job = "6f7d1c2a-3b4e-4f5a-8b9c-0d1e2f3a4b5c";

async function store() {
  return new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-disk-")));
}

describe("disk file store", () => {
  it("writes, reads, lists, and deletes a file with its type", async () => {
    const files = await store();
    const key = `exports/${job}`;
    await files.put(key, Buffer.from("a,b\n1,2\n"), "text/csv");
    const read = await readFile(files, key, 1024);
    expect(read?.bytes.toString()).toBe("a,b\n1,2\n");
    expect(read?.contentType).toBe("text/csv");
    const entries = [];
    for await (const entry of files.list()) entries.push(entry);
    expect(entries).toEqual([
      { key, size: 8, modifiedAt: expect.any(Date) as Date },
    ]);
    await files.delete(key);
    expect(await files.open(key)).toBeUndefined();
    // Deleting twice is not an error.
    await files.delete(key);
  });

  it("leaves no temporary file behind and replaces a file whole", async () => {
    const files = await store();
    const key = "att" + "a".repeat(32);
    await files.put(key, Buffer.from("first"), "text/plain");
    await files.put(key, Buffer.from("second"), "text/plain");
    expect((await readFile(files, key, 1024))?.bytes.toString()).toBe("second");
    const names = await readdir(files.root);
    expect(names.sort()).toEqual([key, `${key}.type`]);
  });

  it("refuses a key that is not one of the application's", async () => {
    const files = await store();
    for (const key of ["../etc/passwd", "exports/../../x", "att", "/abs"]) {
      await expect(
        files.put(key, Buffer.from("x"), "text/plain"),
      ).rejects.toThrow("Invalid file");
    }
  });

  it("skips files it did not write when listing", async () => {
    const files = await store();
    await writeFile(join(files.root, "notes.txt"), "stray");
    const keys: string[] = [];
    for await (const entry of files.list()) keys.push(entry.key);
    expect(keys).toEqual([]);
  });

  it("writes a stream of the announced size, and nothing otherwise", async () => {
    const files = await store();
    const key = `exports/${job}`;
    const stream = (text: string) => Readable.from([Buffer.from(text)]);
    await files.putFile(key, {
      body: stream("a,b\n"),
      size: 4,
      contentType: "text/csv",
    });
    expect(await readFile(files, key, 1024)).toEqual({
      bytes: Buffer.from("a,b\n"),
      contentType: "text/csv",
    });
    const other = "att" + "b".repeat(32);
    for (const size of [3, 5]) {
      await expect(
        files.putFile(other, {
          body: stream("a,b\n"),
          size,
          contentType: "text/plain",
        }),
      ).rejects.toThrow("File size mismatch");
    }
    expect(await files.open(other)).toBeUndefined();
    // No temporary file is left behind; only the type file waits for tidy.
    const names = await readdir(files.root);
    expect(names.filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("tidies old temporary files and lone type files only", async () => {
    const files = await store();
    const kept = "att" + "c".repeat(32);
    await files.put(kept, Buffer.from("x"), "text/plain");
    await mkdir(join(files.root, "exports"));
    const stale = [
      join(files.root, `exports/${job}.tmp-abc`),
      join(files.root, `att${"d".repeat(32)}.type`),
    ];
    const fresh = join(files.root, `att${"e".repeat(32)}.tmp-def`);
    for (const path of [...stale, fresh]) await writeFile(path, "x");
    const old = new Date(Date.now() - 3 * 86_400_000);
    for (const path of stale) await utimes(path, old, old);
    await utimes(join(files.root, `${kept}.type`), old, old);
    expect(await files.tidy(new Date(Date.now() - 86_400_000))).toBe(2);
    const names = (await readdir(files.root)).sort();
    expect(names).toEqual(
      [kept, `${kept}.type`, `att${"e".repeat(32)}.tmp-def`, "exports"].sort(),
    );
  });

  it("refuses to read a file over the limit", async () => {
    const files = await store();
    const key = `exports/${job}`;
    await files.put(key, Buffer.alloc(2048), "application/octet-stream");
    await expect(readFile(files, key, 1024)).rejects.toThrow("File too large");
  });

  it("checks that its folder can be written", async () => {
    const files = await store();
    await expect(files.check()).resolves.toBeUndefined();
  });
});
