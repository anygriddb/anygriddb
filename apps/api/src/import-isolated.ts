import { Worker } from "node:worker_threads";
import type { ImportFormat } from "@anygriddb/core";
import type { ParsedSheet } from "./import-file.js";
import { assertZipWithinLimits } from "./zip-limits.js";
import { AppError } from "@anygriddb/core";

/** What one import parse may use before it is stopped (ADR 0025). */
export const PARSE_LIMITS = {
  heapMb: 512,
  timeMs: 60_000,
  zip: {
    maxEntries: 2_000,
    maxEntryBytes: 256 * 1024 * 1024,
    maxTotalBytes: 512 * 1024 * 1024,
  },
} as const;

type Reply = { ok: true; sheet: ParsedSheet } | { ok: false; message: string };

/** From sources (tsx, Vitest) the worker is TypeScript; in the bundle, not. */
function workerEntry(): { url: URL; execArgv: string[] } {
  const fromSource = import.meta.url.endsWith(".ts");
  return fromSource
    ? {
        url: new URL("./import-worker.ts", import.meta.url),
        execArgv: ["--import", "tsx"],
      }
    : { url: new URL("./import-worker.js", import.meta.url), execArgv: [] };
}

/**
 * Parses an uploaded file in a worker thread with a heap cap and a time
 * limit. A spreadsheet's zip directory is checked first, before anything
 * is inflated.
 */
export async function parseImportFileIsolated(
  format: ImportFormat,
  bytes: Buffer,
  limits: { heapMb: number; timeMs: number } = PARSE_LIMITS,
): Promise<ParsedSheet> {
  if (format === "xlsx") assertZipWithinLimits(bytes, PARSE_LIMITS.zip);
  const entry = workerEntry();
  const worker = new Worker(entry.url, {
    workerData: { format, bytes: new Uint8Array(bytes) },
    execArgv: entry.execArgv,
    resourceLimits: {
      maxOldGenerationSizeMb: limits.heapMb,
      maxYoungGenerationSizeMb: 64,
    },
    stdout: false,
    stderr: false,
  });
  return new Promise<ParsedSheet>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
      void worker.terminate();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new AppError("invalid_import")));
    }, limits.timeMs);
    worker.once("message", (reply: Reply) => {
      settle(() =>
        reply.ok ? resolve(reply.sheet) : reject(new Error(reply.message)),
      );
    });
    // Out of memory, or a crash inside the parser.
    worker.once("error", (error) => {
      settle(() => reject(new AppError("invalid_import", { cause: error })));
    });
    worker.once("exit", () => {
      settle(() => reject(new AppError("invalid_import")));
    });
  });
}
