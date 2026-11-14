import { open } from "node:fs/promises";
import { AppError } from "@anygriddb/core";
/**
 * Reads a zip archive's central directory, without inflating anything, and
 * refuses one that would expand past the limits: an XLSX file is a zip,
 * and a few kilobytes can declare gigabytes (ADR 0025).
 */

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
/** The end record is 22 bytes, plus a comment of up to 65,535. */
const END_SEARCH = 22 + 0xffff;

type ZipLimits = {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
};

type Directory = { entries: number; offset: number; size: number };

/**
 * The central directory the end record names, read from `tail`, the last
 * bytes of an archive of `length` bytes.
 */
function directoryOf(
  tail: Buffer,
  length: number,
  limits: ZipLimits,
): Directory {
  const tailStart = length - tail.length;
  let end = -1;
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === END_OF_DIRECTORY) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new AppError("invalid_import");
  const entries = tail.readUInt16LE(end + 10);
  const size = tail.readUInt32LE(end + 12);
  const offset = tail.readUInt32LE(end + 16);
  // ZIP64 markers: an XLSX within our upload limit never needs them.
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw new AppError("invalid_import");
  }
  if (entries === 0 || entries > limits.maxEntries) {
    throw new AppError("invalid_import");
  }
  if (offset + size > tailStart + end) throw new AppError("invalid_import");
  return { entries, offset, size };
}

/** Adds up what each entry declares it inflates to. */
function checkEntries(
  directory: Buffer,
  entries: number,
  limits: ZipLimits,
): void {
  let offset = 0;
  let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (
      offset + 46 > directory.length ||
      directory.readUInt32LE(offset) !== DIRECTORY_ENTRY
    ) {
      throw new AppError("invalid_import");
    }
    const size = directory.readUInt32LE(offset + 24);
    if (size === 0xffffffff || size > limits.maxEntryBytes) {
      throw new AppError("invalid_import");
    }
    total += size;
    if (total > limits.maxTotalBytes) throw new AppError("invalid_import");
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

export function assertZipWithinLimits(bytes: Buffer, limits: ZipLimits): void {
  if (bytes.length < 22) throw new AppError("invalid_import");
  const tail = bytes.subarray(Math.max(0, bytes.length - END_SEARCH));
  const directory = directoryOf(tail, bytes.length, limits);
  checkEntries(
    bytes.subarray(directory.offset, directory.offset + directory.size),
    directory.entries,
    limits,
  );
}

/** The same check on a file, reading only its end and its directory. */
export async function assertZipFileWithinLimits(
  path: string,
  limits: ZipLimits,
): Promise<void> {
  const handle = await open(path, "r");
  try {
    const { size: length } = await handle.stat();
    if (length < 22) throw new AppError("invalid_import");
    const tail = Buffer.alloc(Math.min(length, END_SEARCH));
    await handle.read(tail, 0, tail.length, length - tail.length);
    const directory = directoryOf(tail, length, limits);
    const bytes = Buffer.alloc(directory.size);
    await handle.read(bytes, 0, directory.size, directory.offset);
    checkEntries(bytes, directory.entries, limits);
  } finally {
    await handle.close();
  }
}
