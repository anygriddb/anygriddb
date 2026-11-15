import { beforeEach, describe, expect, it, vi } from "vitest";

const startTracing = vi.hoisted(() => vi.fn());

vi.mock("../observability.js", () => ({
  startTracing,
}));

import { applyTracing } from "./tracing.js";

describe("trace reload", () => {
  beforeEach(() => {
    startTracing.mockReset();
  });

  it("replaces the running exporter", async () => {
    const stopped = vi.fn(async () => undefined);
    startTracing.mockResolvedValueOnce(stopped);
    await expect(
      applyTracing({
        endpoint: "https://collector.example.com",
        serviceName: "anygriddb",
        version: "0.0.0",
      }),
    ).resolves.toBe("live");
    startTracing.mockResolvedValueOnce(async () => undefined);
    await applyTracing({
      endpoint: "https://other.example.com",
      serviceName: "anygriddb",
      version: "0.0.0",
    });
    expect(stopped).toHaveBeenCalledOnce();
  });

  it("says a restart is required when the library refuses a second start", async () => {
    startTracing.mockRejectedValueOnce(new Error("already registered"));
    await expect(
      applyTracing({
        endpoint: "https://collector.example.com",
        serviceName: "anygriddb",
        version: "0.0.0",
      }),
    ).resolves.toBe("restart");
  });
});
