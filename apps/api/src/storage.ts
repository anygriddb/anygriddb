/**
 * What the application knows about the files it stores: accepted types,
 * how a type is read from the bytes, and the keys of job files. Where the
 * bytes live is the file store's business (`files/`).
 */
import { randomUUID } from "node:crypto";
import { AppError, ATTACHMENT_TYPES } from "@anygriddb/core";
export function sniffContentType(bytes: Buffer, stored?: string): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const gif = bytes.subarray(0, 6).toString("ascii");
    if (gif === "GIF87a" || gif === "GIF89a") {
      return "image/gif";
    }
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (stored && (ATTACHMENT_TYPES as readonly string[]).includes(stored)) {
    return stored;
  }
  return "application/octet-stream";
}

/** Key of an export job's file: one per job. */
const EXPORT_KEY = /^exports\/[0-9a-f-]{36}$/;

export function exportKey(jobId: string): string {
  const key = `exports/${jobId}`;
  if (!EXPORT_KEY.test(key)) {
    throw new AppError("invalid_job");
  }
  return key;
}

export function newStagedKey(): string {
  return `staged/${randomUUID()}`;
}
