/**
 * Worker thread entry: parses one uploaded import file and posts the
 * result. A hostile file can exhaust this thread's heap or time, never the
 * API process (ADR 0025).
 */
import { parentPort, workerData } from "node:worker_threads";
import type { ImportFormat } from "@anygriddb/core";
import { parseImportFile } from "./import-file.js";

type Input = { format: ImportFormat; bytes: Uint8Array };

const input = workerData as Input;
parseImportFile(input.format, Buffer.from(input.bytes))
  .then((sheet) => parentPort?.postMessage({ ok: true, sheet }))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Invalid import";
    parentPort?.postMessage({
      ok: false,
      // Only the two refusals a person can act on cross the boundary.
      message: message === "Too many rows" ? message : "Invalid import",
    });
  });
