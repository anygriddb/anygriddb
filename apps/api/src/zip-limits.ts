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

export type ZipLimits = {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
};

export function assertZipWithinLimits(bytes: Buffer, limits: ZipLimits): void {
  const from = Math.max(0, bytes.length - END_SEARCH);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= from; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_OF_DIRECTORY) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new AppError("invalid_import");
  const entries = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  // ZIP64 markers: an XLSX within our upload limit never needs them.
  if (
    entries === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new AppError("invalid_import");
  }
  if (entries === 0 || entries > limits.maxEntries) {
    throw new AppError("invalid_import");
  }
  if (directoryOffset + directorySize > end)
    throw new AppError("invalid_import");
  let offset = directoryOffset;
  let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== DIRECTORY_ENTRY) {
      throw new AppError("invalid_import");
    }
    const size = bytes.readUInt32LE(offset + 24);
    if (size === 0xffffffff || size > limits.maxEntryBytes) {
      throw new AppError("invalid_import");
    }
    total += size;
    if (total > limits.maxTotalBytes) throw new AppError("invalid_import");
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    offset += 46 + nameLength + extraLength + commentLength;
  }
}
