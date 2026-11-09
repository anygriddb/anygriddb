import { describe, expect, it } from "vitest";
import {
  JOB_KINDS,
  JOB_PROGRESS_INTERVAL_MS,
  exportJobInputSchema,
  importJobInputSchema,
  isActiveJob,
  jobFraction,
  progressDue,
} from "./jobs";
import {
  exportSnapshotJobInputSchema,
  importSnapshotJobInputSchema,
} from "./snapshot";

const id = "0b5c4f3e-8a5e-4c43-9f61-2d4b8d1c7a10";

describe("job progress", () => {
  it("reports a fraction once the total is known", () => {
    expect(jobFraction(25, 100)).toBe(0.25);
    expect(jobFraction(120, 100)).toBe(1);
    expect(jobFraction(3, null)).toBeNull();
    expect(jobFraction(0, 0)).toBeNull();
  });

  it("writes the first and last report, and throttles the rest", () => {
    expect(progressDue(undefined, 0, 0, 10)).toBe(true);
    expect(progressDue(1_000, 1_100, 5, 10)).toBe(false);
    expect(progressDue(1_000, 1_100, 10, 10)).toBe(true);
    expect(progressDue(1_000, 1_000 + JOB_PROGRESS_INTERVAL_MS, 6, null)).toBe(
      true,
    );
  });

  it("tells active jobs from finished ones", () => {
    expect(isActiveJob("queued")).toBe(true);
    expect(isActiveJob("running")).toBe(true);
    expect(isActiveJob("done")).toBe(false);
    expect(isActiveJob("cancelled")).toBe(false);
  });
});

describe("job inputs", () => {
  it("accepts an export of a view and defaults to CSV", () => {
    const parsed = exportJobInputSchema.parse({ tableId: id, viewId: id });
    expect(parsed.format).toBe("csv");
  });

  it("refuses unknown keys and bad formats", () => {
    expect(
      exportJobInputSchema.safeParse({ tableId: id, format: "pdf" }).success,
    ).toBe(false);
    expect(
      exportJobInputSchema.safeParse({ tableId: id, extra: true }).success,
    ).toBe(false);
  });

  it("checks an import's mapping and staged id", () => {
    const input = {
      importId: "a".repeat(32),
      tableId: id,
      mapping: [{ source: 0, column: "name" }],
      addOptions: true,
    };
    expect(importJobInputSchema.safeParse(input).success).toBe(true);
    expect(
      importJobInputSchema.safeParse({ ...input, importId: "short" }).success,
    ).toBe(false);
    expect(
      importJobInputSchema.safeParse({ ...input, mapping: [] }).success,
    ).toBe(false);
  });

  it("accepts snapshot export and import inputs", () => {
    expect(JOB_KINDS).toContain("export_snapshot");
    expect(JOB_KINDS).toContain("import_snapshot");
    expect(
      exportSnapshotJobInputSchema.parse({ baseId: id, withData: false })
        .withData,
    ).toBe(false);
    expect(
      importSnapshotJobInputSchema.safeParse({
        snapshotId: "a".repeat(32),
      }).success,
    ).toBe(true);
  });
});
