import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isZip, ZipError, ZipReader, ZipWriter } from "./zip.js";

describe("ZIP archives", () => {
  let folder = "";
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "anygriddb-zip-"));
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  async function archive(name: string) {
    const path = join(folder, name);
    const writer = new ZipWriter(path);
    const document = Buffer.from(JSON.stringify({ hello: "é".repeat(5000) }));
    const file = randomBytes(300_000);
    await writer.addBuffer("snapshot.json", document);
    const seen: Buffer[] = [];
    const size = await writer.addStream(
      "files/attA",
      Readable.from([file.subarray(0, 1000), file.subarray(1000)]),
      (chunk) => seen.push(chunk),
    );
    await writer.addStream("files/empty", Readable.from([]));
    const total = await writer.finish();
    return { path, document, file, size, total, seen };
  }

  it("reads back what it wrote, deflated or stored", async () => {
    const made = await archive("round.zip");
    expect(made.size).toBe(made.file.length);
    expect(Buffer.concat(made.seen).equals(made.file)).toBe(true);
    const bytes = await readFile(made.path);
    expect(bytes.length).toBe(made.total);
    expect(isZip(bytes)).toBe(true);
    expect(isZip(Buffer.from("{}"))).toBe(false);

    const reader = await ZipReader.open(made.path, { maxEntries: 10 });
    expect([...reader.entries.keys()]).toEqual([
      "snapshot.json",
      "files/attA",
      "files/empty",
    ]);
    expect(reader.entries.get("snapshot.json")?.compressed).toBeLessThan(
      made.document.length,
    );
    expect(
      (await reader.read("snapshot.json", 1e6))?.equals(made.document),
    ).toBe(true);
    expect((await reader.read("files/attA", 1e6))?.equals(made.file)).toBe(
      true,
    );
    expect((await reader.read("files/empty", 10))?.length).toBe(0);
    expect(await reader.read("files/none", 10)).toBeUndefined();
  });

  it("refuses an entry over the limit, a changed byte, and a duplicate name", async () => {
    const made = await archive("broken.zip");
    const reader = await ZipReader.open(made.path, { maxEntries: 10 });
    await expect(reader.read("files/attA", 1000)).rejects.toThrow(ZipError);
    await expect(ZipReader.open(made.path, { maxEntries: 2 })).rejects.toThrow(
      "Too many entries",
    );

    const bytes = await readFile(made.path);
    const entry = reader.entries.get("files/attA");
    if (!entry) throw new Error("no entry");
    // A byte inside the stored file: its CRC no longer matches.
    const corrupt = Buffer.from(bytes);
    const at = entry.offset + 30 + "files/attA".length + 10;
    corrupt[at] = (corrupt[at] ?? 0) ^ 0xff;
    const path = join(folder, "corrupt.zip");
    await writeFile(path, corrupt);
    const damaged = await ZipReader.open(path, { maxEntries: 10 });
    await expect(damaged.read("files/attA", 1e6)).rejects.toThrow(
      "Broken entry",
    );

    const twice = new ZipWriter(join(folder, "twice.zip"));
    await twice.addBuffer("a", Buffer.from("1"));
    await expect(twice.addBuffer("a", Buffer.from("2"))).rejects.toThrow(
      "Duplicate entry",
    );
    twice.abort();
    await writeFile(join(folder, "plain.json"), "{}");
    await expect(
      ZipReader.open(join(folder, "plain.json"), { maxEntries: 10 }),
    ).rejects.toThrow("Not a ZIP archive");
  });
});
