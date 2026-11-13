import { AppError } from "@anygriddb/core";
import { describe, expect, it, vi } from "vitest";
import { recordingBus } from "./realtime/recording-bus.test-helpers.js";
import {
  JobCancelled,
  jobCanRetry,
  jobError,
  publicJob,
  publishJob,
  type JobRow,
} from "./jobs.js";

const job: JobRow = {
  id: "6f7d1c2a-3b4e-4f5a-8b9c-0d1e2f3a4b5c",
  kind: "export",
  status: "running",
  userId: "0b5c4f3e-8a5e-4c43-9f61-2d4b8d1c7a10",
  baseId: null,
  tableId: null,
  input: {},
  result: null,
  error: null,
  errorCode: null,
  errorDetail: null,
  progressDone: 0,
  progressTotal: null,
  attempts: 1,
  cancelRequested: false,
  leaseUntil: new Date(),
  fileKey: null,
  fileExpiresAt: null,
  createdAt: new Date("2026-11-07T10:00:00Z"),
  startedAt: new Date("2026-11-07T10:00:01Z"),
  finishedAt: null,
};

describe("job helpers", () => {
  it("publishes nothing for a job without an author", async () => {
    const { bus, published } = recordingBus();
    await publishJob(bus, { ...job, userId: null }, vi.fn());
    expect(published).toHaveLength(0);
  });

  it("offers a download only for a finished export still in date", () => {
    const later = new Date(Date.now() + 60_000);
    const earlier = new Date(Date.now() - 60_000);
    const done = { ...job, status: "done" as const, fileKey: "exports/x" };
    expect(publicJob({ ...done, fileExpiresAt: later }).download).toBe(true);
    expect(publicJob({ ...done, fileExpiresAt: earlier }).download).toBe(false);
    expect(
      publicJob({ ...done, status: "running", fileExpiresAt: later }).download,
    ).toBe(false);
  });

  it("offers a retry for a failed export or copy, never for an import", () => {
    for (const kind of [
      "export",
      "export_snapshot",
      "duplicate_table",
      "duplicate_base",
    ] as const) {
      expect(jobCanRetry({ kind, status: "failed" })).toBe(true);
    }
    // An import may have written rows before it failed.
    for (const kind of [
      "import",
      "import_snapshot",
      "import_airtable",
      "trash_purge",
    ] as const) {
      expect(jobCanRetry({ kind, status: "failed" })).toBe(false);
    }
    for (const status of ["queued", "running", "done", "cancelled"] as const) {
      expect(jobCanRetry({ kind: "export", status })).toBe(false);
    }
    expect(publicJob({ ...job, status: "failed" }).retryable).toBe(true);
    expect(publicJob(job).retryable).toBe(false);
  });

  it("keeps public errors and hides the rest", () => {
    expect(jobError(new JobCancelled())).toEqual({
      code: "job_cancelled",
      message: "Job cancelled",
    });
    expect(jobError(new AppError("unknown_column", "prix"))).toEqual({
      code: "unknown_column",
      detail: "prix",
      message: "Unknown column: prix",
    });
    expect(jobError(new Error("relation t_x does not exist"))).toEqual({
      code: "internal_error",
      message: "Internal error",
    });
    expect(jobError("text")).toMatchObject({ code: "internal_error" });
  });
});
