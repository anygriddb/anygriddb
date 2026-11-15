import { describe, expect, it } from "vitest";
import { AppError } from "@anygriddb/core";
import { measureSource, registry } from "./observability.js";
import { SOURCE_LOAD_SLOW_MS } from "./source-load.js";

describe("source load", () => {
  it("counts a second or more as slow", () => {
    expect(SOURCE_LOAD_SLOW_MS).toBe(1_000);
  });

  it("labels a source timeout separately from other errors", async () => {
    registry.resetMetrics();
    await expect(
      measureSource({ id: "s-timeout", engine: "postgresql" }, "read", () =>
        Promise.reject(new AppError("source_timeout")),
      ),
    ).rejects.toMatchObject({ code: "source_timeout" });
    const body = await registry.metrics();
    expect(body).toMatch(
      /anygriddb_source_operation_duration_seconds_count\{[^}]*outcome="timeout"/,
    );
  });

  it("labels a plain source failure as error", async () => {
    registry.resetMetrics();
    await expect(
      measureSource({ id: "s-error", engine: "postgresql" }, "write", () =>
        Promise.reject(new AppError("source_unreachable")),
      ),
    ).rejects.toMatchObject({ code: "source_unreachable" });
    const body = await registry.metrics();
    expect(body).toMatch(
      /anygriddb_source_operation_duration_seconds_count\{[^}]*outcome="error"/,
    );
  });
});
