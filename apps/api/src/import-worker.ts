/**
 * Worker thread entry: reads one import file and posts what it finds. A
 * hostile file can exhaust this thread's heap or time, never the API
 * process (ADR 0025). Reading rows, it posts a batch, then waits to be
 * asked for the next (ADR 0064).
 */
import { parentPort, workerData } from "node:worker_threads";
import { AppError } from "@anygriddb/core";
import { readImportFile, scanImportFile, scanWorkbook } from "./import-file.js";
import type { WorkerReply, WorkerTask } from "./import-isolated.js";

const port = parentPort;
const task = workerData as WorkerTask;

function post(reply: WorkerReply): void {
  port?.postMessage(reply);
}

function fail(error: unknown): void {
  post({
    kind: "error",
    code:
      error instanceof AppError && error.code === "import_too_large"
        ? "import_too_large"
        : "invalid_import",
  });
}

function asked(): Promise<void> {
  return new Promise((resolve) => {
    port?.once("message", () => {
      resolve();
    });
  });
}

async function run(): Promise<void> {
  if (task.mode === "workbook") {
    post({
      kind: "workbook",
      sheets: await scanWorkbook(task.path, task.maxRows),
    });
    return;
  }
  if (task.mode === "scan") {
    const { shape, preview } = await scanImportFile(
      task.format,
      task.path,
      task.maxRows,
    );
    post({ kind: "scan", shape, preview });
    return;
  }
  for await (const rows of readImportFile(
    task.shape,
    task.path,
    task.size,
    task.maxRows,
  )) {
    post({ kind: "batch", rows });
    await asked();
  }
  post({ kind: "done" });
}

run().catch(fail);
