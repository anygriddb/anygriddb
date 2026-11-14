import { Worker } from "node:worker_threads";
import { AppError, type ImportFormat } from "@anygriddb/core";
import type {
  ImportPreview,
  SheetRow,
  SheetShape,
  WorkbookSheet,
} from "./import-file.js";
import { assertZipFileWithinLimits } from "./zip-limits.js";

/**
 * What reading an import file may use before it is stopped (ADR 0025,
 * ADR 0064): a heap of its own, a time for the first pass over the whole
 * file, and a time for each batch of the second, the writes between
 * batches apart.
 */
export const PARSE_LIMITS = {
  heapMb: 512,
  scanMs: 300_000,
  batchMs: 60_000,
  zip: {
    maxEntries: 2_000,
    maxEntryBytes: 1024 * 1024 * 1024,
    maxTotalBytes: 2048 * 1024 * 1024,
  },
} as const;

type ParseLimits = { heapMb: number; timeMs: number };

/** What the worker is asked to do. */
export type WorkerTask =
  | { mode: "scan"; format: ImportFormat; path: string; maxRows: number }
  | { mode: "workbook"; path: string; maxRows: number }
  | {
      mode: "read";
      shape: SheetShape;
      path: string;
      size: number;
      maxRows: number;
    };

/** What it answers. Only the refusals a person can act on cross over. */
export type WorkerReply =
  | { kind: "scan"; shape: SheetShape; preview: ImportPreview }
  | { kind: "workbook"; sheets: WorkbookSheet[] }
  | { kind: "batch"; rows: SheetRow[] }
  | { kind: "done" }
  | { kind: "error"; code: "invalid_import" | "import_too_large" };

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
 * A worker thread for one task, with a capped heap, and its replies in
 * the order they come. A reply waited for longer than `timeMs`, a crash,
 * or an exit ends it with `invalid_import`.
 */
class ParseWorker {
  private readonly worker: Worker;
  private readonly replies: WorkerReply[] = [];
  private failure: unknown;
  private waiting: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(task: WorkerTask, heapMb: number) {
    const entry = workerEntry();
    this.worker = new Worker(entry.url, {
      workerData: task,
      execArgv: entry.execArgv,
      resourceLimits: {
        maxOldGenerationSizeMb: heapMb,
        maxYoungGenerationSizeMb: 64,
      },
      stdout: false,
      stderr: false,
    });
    this.worker.on("message", (reply: WorkerReply) => {
      this.replies.push(reply);
      this.wake();
    });
    // Out of memory, or a crash inside the parser.
    this.worker.once("error", (error) => {
      this.fail(new AppError("invalid_import", { cause: error }));
    });
    this.worker.once("exit", () => {
      this.fail(new AppError("invalid_import"));
    });
  }

  /** The next reply, within `timeMs` of asking for it. */
  async next(timeMs: number): Promise<WorkerReply> {
    if (this.replies.length === 0 && this.failure === undefined) {
      this.timer = setTimeout(() => {
        this.fail(new AppError("invalid_import"));
      }, timeMs);
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
    const reply = this.replies.shift();
    if (reply) return reply;
    throw this.failure;
  }

  /** Lets the worker read its next batch. */
  more(): void {
    this.worker.postMessage("next");
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    this.worker.removeAllListeners();
    await this.worker.terminate();
  }

  private fail(error: unknown): void {
    this.failure ??= error;
    this.wake();
  }

  private wake(): void {
    clearTimeout(this.timer);
    const resolve = this.waiting;
    this.waiting = undefined;
    resolve?.();
  }
}

function refused(reply: WorkerReply): never {
  throw new AppError(reply.kind === "error" ? reply.code : "invalid_import");
}

/**
 * The first pass over an uploaded file, in a worker thread: its columns,
 * how many rows it holds, and a sample. A spreadsheet's zip directory is
 * checked first, before anything is inflated.
 */
export async function scanImportFileIsolated(
  format: ImportFormat,
  path: string,
  maxRows: number,
  limits: ParseLimits = {
    heapMb: PARSE_LIMITS.heapMb,
    timeMs: PARSE_LIMITS.scanMs,
  },
): Promise<{ shape: SheetShape; preview: ImportPreview }> {
  if (format === "xlsx") {
    await assertZipFileWithinLimits(path, PARSE_LIMITS.zip);
  }
  const worker = new ParseWorker(
    { mode: "scan", format, path, maxRows },
    limits.heapMb,
  );
  try {
    const reply = await worker.next(limits.timeMs);
    if (reply.kind !== "scan") refused(reply);
    return { shape: reply.shape, preview: reply.preview };
  } finally {
    await worker.stop();
  }
}

/**
 * The first pass over an uploaded workbook, in a worker thread: each of
 * its worksheets that holds a header (ADR 0078). Its zip directory is
 * checked first, before anything is inflated.
 */
export async function scanWorkbookIsolated(
  path: string,
  maxRows: number,
  limits: ParseLimits = {
    heapMb: PARSE_LIMITS.heapMb,
    timeMs: PARSE_LIMITS.scanMs,
  },
): Promise<WorkbookSheet[]> {
  await assertZipFileWithinLimits(path, PARSE_LIMITS.zip);
  const worker = new ParseWorker(
    { mode: "workbook", path, maxRows },
    limits.heapMb,
  );
  try {
    const reply = await worker.next(limits.timeMs);
    if (reply.kind !== "workbook") refused(reply);
    return reply.sheets;
  } finally {
    await worker.stop();
  }
}

/**
 * The file's rows, `size` at a time, read in a worker thread as the first
 * pass found them. The worker reads the next batch while the caller
 * writes this one, and never more.
 */
export async function* readImportFileIsolated(
  shape: SheetShape,
  path: string,
  size: number,
  maxRows: number,
  limits: ParseLimits = {
    heapMb: PARSE_LIMITS.heapMb,
    timeMs: PARSE_LIMITS.batchMs,
  },
): AsyncGenerator<SheetRow[]> {
  if (shape.format === "xlsx") {
    await assertZipFileWithinLimits(path, PARSE_LIMITS.zip);
  }
  const worker = new ParseWorker(
    { mode: "read", shape, path, size, maxRows },
    limits.heapMb,
  );
  try {
    for (;;) {
      const reply = await worker.next(limits.timeMs);
      if (reply.kind === "done") return;
      if (reply.kind !== "batch") refused(reply);
      worker.more();
      yield reply.rows;
    }
  } finally {
    await worker.stop();
  }
}
