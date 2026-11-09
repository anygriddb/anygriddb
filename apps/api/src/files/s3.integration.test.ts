/**
 * The S3 driver against a real S3 service, RustFS, the one the optional
 * compose overlay runs. Other services speak the same protocol.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiskStore } from "./disk.js";
import { S3Store } from "./s3.js";
import { readFile, type FileStore } from "./store.js";
import { copyFiles } from "./transfer.js";

const job = "6f7d1c2a-3b4e-4f5a-8b9c-0d1e2f3a4b5c";

async function keysOf(files: FileStore): Promise<string[]> {
  const keys: string[] = [];
  for await (const entry of files.list()) keys.push(entry.key);
  return keys.sort();
}

describe("S3 file store", () => {
  let container: StartedTestContainer | undefined;
  let files: S3Store;
  const settings = () => {
    if (!container) throw new Error("RustFS is not running");
    return {
      endpoint: `http://${container.getHost()}:${String(container.getMappedPort(9000))}`,
      region: "us-east-1",
      accessKey: "anygriddbtest",
      secretKey: "anygriddbtestsecret",
      bucket: "anygriddb-test",
    };
  };

  beforeAll(async () => {
    container = await new GenericContainer("rustfs/rustfs:1.0.4")
      .withEnvironment({
        RUSTFS_ACCESS_KEY: "anygriddbtest",
        RUSTFS_SECRET_KEY: "anygriddbtestsecret",
        RUSTFS_ADDRESS: ":9000",
        RUSTFS_CONSOLE_ENABLE: "false",
        RUSTFS_VOLUMES: "/data",
        RUSTFS_OBS_LOG_DIRECTORY: "",
        RUSTFS_UNSAFE_BYPASS_DISK_CHECK: "true",
      })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp("/health", 9000))
      .start();
    files = new S3Store(settings());
    // Creates the bucket.
    await files.check();
  });

  afterAll(async () => {
    await container?.stop();
  });

  it("lists a bucket not created yet as empty", async () => {
    const absent = new S3Store({ ...settings(), bucket: "anygriddb-absent" });
    expect(await keysOf(absent)).toEqual([]);
  });

  it("writes, streams, lists, and deletes files with their type", async () => {
    const attachment = `att${"a".repeat(32)}`;
    await files.put(attachment, Buffer.from("png bytes"), "image/png");
    const exported = `exports/${job}`;
    await files.putFile(exported, {
      body: Readable.from([Buffer.from("a,b\n"), Buffer.from("1,2\n")]),
      size: 8,
      contentType: "text/csv",
    });
    expect(await readFile(files, exported, 100)).toEqual({
      bytes: Buffer.from("a,b\n1,2\n"),
      contentType: "text/csv",
    });
    const entries = [];
    for await (const entry of files.list()) entries.push(entry);
    expect(entries.map(({ key, size }) => ({ key, size })).sort()).toEqual([
      { key: attachment, size: 9 },
      { key: exported, size: 8 },
    ]);
    expect(entries[0]?.modifiedAt).toBeInstanceOf(Date);
    await files.delete(attachment);
    await files.delete(exported);
    expect(await files.open(attachment)).toBeUndefined();
    expect(await keysOf(files)).toEqual([]);
    expect(await files.tidy(new Date())).toBe(0);
  });

  it("refuses a stream that is not the announced size, and stores nothing", async () => {
    const key = `att${"b".repeat(32)}`;
    for (const size of [3, 20]) {
      await expect(
        files.putFile(key, {
          body: Readable.from([Buffer.from("twelve bytes")]),
          size,
          contentType: "text/plain",
        }),
      ).rejects.toThrow();
    }
    expect(await files.open(key)).toBeUndefined();
  });

  it("moves files from disk to the bucket and back, byte for byte", async () => {
    const disk = new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-s3-")));
    const keys = [`att${"c".repeat(32)}`, `staged/${job}`];
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    await disk.put(keys[0] ?? "", big, "image/webp");
    await disk.put(keys[1] ?? "", Buffer.from("{}"), "application/json");
    const onError = (key: string, error: unknown) => {
      throw new Error(`${key}: ${String(error)}`);
    };
    expect(await copyFiles(disk, files, { onError })).toMatchObject({
      copied: 2,
      failed: 0,
    });
    expect(await copyFiles(disk, files, { onError })).toMatchObject({
      copied: 0,
      skipped: 2,
    });
    const back = new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-s3-")));
    await copyFiles(files, back, { onError });
    expect(await readFile(back, keys[0] ?? "", big.length)).toEqual({
      bytes: big,
      contentType: "image/webp",
    });
    expect(await keysOf(back)).toEqual([...keys].sort());
  });
});
