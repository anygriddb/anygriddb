/**
 * ZIP archives, the part base snapshots need (ADR 0039): written as a
 * stream to a local file, read back by their central directory. Files are
 * stored as they are (attachments are mostly compressed already); a
 * document can be deflated. No ZIP64: an archive stays under 4 GiB and
 * 65,535 entries, and anything else is refused. Node's zlib only.
 */
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import type { Readable } from "node:stream";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
/** Sizes are known after the data (bit 3); names are UTF-8 (bit 11). */
const FLAGS = 0x0008 | 0x0800;
const LIMIT = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

type Written = {
  name: Buffer;
  method: 0 | 8;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
};

/** DOS date and time, as ZIP keeps them. */
function dosTime(date: Date): { time: number; day: number } {
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    day:
      ((Math.max(1980, date.getFullYear()) - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  };
}

/** Writes an archive to a local file, one entry after another. */
export class ZipWriter {
  private readonly out: WriteStream;
  private readonly entries: Written[] = [];
  private readonly names = new Set<string>();
  private offset = 0;
  private readonly stamp = dosTime(new Date());

  constructor(path: string) {
    this.out = createWriteStream(path, { flags: "wx", mode: 0o600 });
  }

  private async write(chunk: Buffer): Promise<void> {
    this.offset += chunk.length;
    if (this.offset > LIMIT) throw new ZipError("Archive too large");
    if (!this.out.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => {
          this.out.off("drain", drained);
          reject(error);
        };
        const drained = () => {
          this.out.off("error", failed);
          resolve();
        };
        this.out.once("drain", drained);
        this.out.once("error", failed);
      });
    }
  }

  private header(name: Buffer, method: 0 | 8): Buffer {
    const head = Buffer.alloc(30);
    head.writeUInt32LE(LOCAL, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(FLAGS, 6);
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(this.stamp.time, 10);
    head.writeUInt16LE(this.stamp.day, 12);
    // CRC and sizes follow the data, in its descriptor.
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    return Buffer.concat([head, name]);
  }

  private begin(name: string): Buffer {
    if (this.names.has(name)) throw new ZipError(`Duplicate entry: ${name}`);
    if (this.entries.length >= MAX_ENTRIES)
      throw new ZipError("Too many entries");
    this.names.add(name);
    return Buffer.from(name, "utf8");
  }

  private async end(entry: Written): Promise<void> {
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(DESCRIPTOR, 0);
    descriptor.writeUInt32LE(entry.crc, 4);
    descriptor.writeUInt32LE(entry.compressed, 8);
    descriptor.writeUInt32LE(entry.size, 12);
    await this.write(descriptor);
    this.entries.push(entry);
  }

  /** A document, deflated. */
  async addBuffer(name: string, bytes: Buffer): Promise<void> {
    const encoded = this.begin(name);
    const offset = this.offset;
    const packed = deflateRawSync(bytes);
    await this.write(this.header(encoded, 8));
    await this.write(packed);
    await this.end({
      name: encoded,
      method: 8,
      crc: crc32(bytes),
      compressed: packed.length,
      size: bytes.length,
      offset,
    });
  }

  /** A file, stored as it is, from a stream; returns its byte count. */
  async addStream(
    name: string,
    body: Readable,
    onChunk?: (chunk: Buffer) => void,
  ): Promise<number> {
    const encoded = this.begin(name);
    const offset = this.offset;
    await this.write(this.header(encoded, 0));
    let crc = 0;
    let size = 0;
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      crc = crc32(buffer, crc);
      size += buffer.length;
      onChunk?.(buffer);
      await this.write(buffer);
    }
    await this.end({
      name: encoded,
      method: 0,
      crc,
      compressed: size,
      size,
      offset,
    });
    return size;
  }

  /** Writes the directory and closes the file; returns its size. */
  async finish(): Promise<number> {
    const start = this.offset;
    for (const entry of this.entries) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(CENTRAL, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(FLAGS, 8);
      record.writeUInt16LE(entry.method, 10);
      record.writeUInt16LE(this.stamp.time, 12);
      record.writeUInt16LE(this.stamp.day, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.compressed, 20);
      record.writeUInt32LE(entry.size, 24);
      record.writeUInt16LE(entry.name.length, 28);
      record.writeUInt32LE(entry.offset, 42);
      await this.write(Buffer.concat([record, entry.name]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    await new Promise<void>((resolve, reject) => {
      this.out.once("error", reject);
      this.out.end(resolve);
    });
    return this.offset;
  }

  /** Gives up: the caller removes the file. */
  abort(): void {
    this.out.destroy();
  }
}

type ZipEntry = {
  name: string;
  method: 0 | 8;
  crc: number;
  compressed: number;
  size: number;
  /** Where the entry's local header starts. */
  offset: number;
};

/** Whether bytes start like a ZIP archive. */
export function isZip(head: Buffer): boolean {
  return head.length >= 4 && head.readUInt32LE(0) === LOCAL;
}

/**
 * Reads an archive's directory from a local file. Entries are looked up
 * by name; reading one checks its size and CRC.
 */
export class ZipReader {
  private constructor(
    private readonly path: string,
    private readonly fileSize: number,
    readonly entries: ReadonlyMap<string, ZipEntry>,
  ) {}

  static async open(
    path: string,
    limits: { maxEntries: number },
  ): Promise<ZipReader> {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const tailLength = Math.min(size, 22 + 0xffff);
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, size - tailLength);
      let at = -1;
      for (let index = tailLength - 22; index >= 0; index -= 1) {
        if (tail.readUInt32LE(index) === END) {
          at = index;
          break;
        }
      }
      if (at < 0) throw new ZipError("Not a ZIP archive");
      const count = tail.readUInt16LE(at + 10);
      const directorySize = tail.readUInt32LE(at + 12);
      const directoryStart = tail.readUInt32LE(at + 16);
      if (count > limits.maxEntries) throw new ZipError("Too many entries");
      if (directoryStart + directorySize > size) {
        throw new ZipError("Broken archive");
      }
      const directory = Buffer.alloc(directorySize);
      await handle.read(directory, 0, directorySize, directoryStart);
      const entries = new Map<string, ZipEntry>();
      let cursor = 0;
      for (let index = 0; index < count; index += 1) {
        if (
          cursor + 46 > directory.length ||
          directory.readUInt32LE(cursor) !== CENTRAL
        ) {
          throw new ZipError("Broken archive");
        }
        const flags = directory.readUInt16LE(cursor + 8);
        const method = directory.readUInt16LE(cursor + 10);
        const nameLength = directory.readUInt16LE(cursor + 28);
        const extraLength = directory.readUInt16LE(cursor + 30);
        const commentLength = directory.readUInt16LE(cursor + 32);
        if (flags & 0x0001)
          throw new ZipError("Encrypted entries are not read");
        if (method !== 0 && method !== 8) {
          throw new ZipError("Unsupported compression");
        }
        const entry: ZipEntry = {
          name: directory.toString(
            "utf8",
            cursor + 46,
            cursor + 46 + nameLength,
          ),
          method,
          crc: directory.readUInt32LE(cursor + 16),
          compressed: directory.readUInt32LE(cursor + 20),
          size: directory.readUInt32LE(cursor + 24),
          offset: directory.readUInt32LE(cursor + 42),
        };
        if (entry.offset + 30 + entry.compressed > size) {
          throw new ZipError("Broken archive");
        }
        if (entries.has(entry.name)) {
          throw new ZipError(`Duplicate entry: ${entry.name}`);
        }
        entries.set(entry.name, entry);
        cursor += 46 + nameLength + extraLength + commentLength;
      }
      return new ZipReader(path, size, entries);
    } finally {
      await handle.close();
    }
  }

  /** Where an entry's data starts: after its local header. */
  private async dataStart(entry: ZipEntry): Promise<number> {
    const handle = await open(this.path, "r");
    try {
      const head = Buffer.alloc(30);
      await handle.read(head, 0, 30, entry.offset);
      if (head.readUInt32LE(0) !== LOCAL) throw new ZipError("Broken archive");
      const start =
        entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      if (start + entry.compressed > this.fileSize) {
        throw new ZipError("Broken archive");
      }
      return start;
    } finally {
      await handle.close();
    }
  }

  /**
   * An entry's bytes, `maxBytes` at most, checked against its size and
   * CRC. Undefined when the archive has no such entry.
   */
  async read(name: string, maxBytes: number): Promise<Buffer | undefined> {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    if (entry.size > maxBytes || entry.compressed > maxBytes) {
      throw new ZipError("Entry too large");
    }
    const start = await this.dataStart(entry);
    const chunks: Buffer[] = [];
    if (entry.compressed > 0) {
      const stream = createReadStream(this.path, {
        start,
        end: start + entry.compressed - 1,
      });
      for await (const chunk of stream) chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks);
    let bytes: Buffer;
    try {
      bytes =
        entry.method === 0
          ? raw
          : inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      throw new ZipError("Broken entry");
    }
    if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) {
      throw new ZipError("Broken entry");
    }
    return bytes;
  }
}
