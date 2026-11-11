import { describe, expect, it, vi } from "vitest";
import {
  routeLabel,
  measureJob,
  measureSource,
  metricsAllowed,
  registerPoolGauge,
  registry,
  requestAnswered,
} from "./observability.js";

describe("metrics", () => {
  it("labels built files as one route, whatever their names", () => {
    expect(routeLabel("/assets/index-DBpHQRC8.js")).toBe("/assets/*");
    expect(routeLabel("/theme.js")).toBe("/static");
    expect(routeLabel("/trpc/:path")).toBe("/trpc/:path");
    expect(routeLabel("/api/v1/tables/:tableId/records.csv")).toBe(
      "/api/v1/tables/:tableId/records.csv",
    );
  });

  it("answers the operator's token only", () => {
    const token = "t".repeat(40);
    expect(metricsAllowed(undefined, `Bearer ${token}`)).toBe(false);
    expect(metricsAllowed(token, undefined)).toBe(false);
    expect(metricsAllowed(token, `Bearer ${"x".repeat(40)}`)).toBe(false);
    expect(metricsAllowed(token, `Bearer ${token}x`)).toBe(false);
    expect(metricsAllowed(token, token)).toBe(false);
    expect(metricsAllowed(token, `Bearer ${token}`)).toBe(true);
  });

  it("reports the most requests seen waiting for the pool between two scrapes", async () => {
    vi.useFakeTimers();
    const pool = {
      totalCount: 10,
      idleCount: 0,
      waitingCount: 0,
      options: { max: 10 },
    };
    const stop = registerPoolGauge(pool);
    const scrape = () =>
      registry.getSingleMetricAsString("anygriddb_db_pool_connections");
    try {
      // Seven requests wait for a moment, then none: the scrape that
      // follows still tells of the seven.
      pool.waitingCount = 7;
      vi.advanceTimersByTime(1_000);
      pool.waitingCount = 0;
      vi.advanceTimersByTime(1_000);
      const first = await scrape();
      expect(first).toContain('anygriddb_db_pool_connections{state="open"} 10');
      expect(first).toContain(
        'anygriddb_db_pool_connections{state="waiting"} 7',
      );
      expect(first).toContain('anygriddb_db_pool_connections{state="max"} 10');
      // Nobody waited since: the next scrape says so.
      vi.advanceTimersByTime(1_000);
      expect(await scrape()).toContain(
        'anygriddb_db_pool_connections{state="waiting"} 0',
      );
      // The scrape's own queries, in line at the instant it reads, are
      // not a wait.
      pool.waitingCount = 2;
      expect(await scrape()).toContain(
        'anygriddb_db_pool_connections{state="waiting"} 0',
      );
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("counts requests by route pattern, sources and jobs by outcome", async () => {
    requestAnswered(
      {},
      {
        method: "GET",
        route: "/api/v1/tables/:tableId",
        status: 200,
        seconds: 0.01,
      },
    );
    await measureSource({ id: "s1", engine: "mysql" }, "read", () =>
      Promise.resolve(1),
    );
    await expect(
      measureJob("external_sync", () => Promise.reject(new Error("down"))),
    ).rejects.toThrow("down");
    const text = await registry.metrics();
    expect(text).toContain(
      'anygriddb_http_requests_total{method="GET",route="/api/v1/tables/:tableId",status="2xx"} 1',
    );
    expect(text).toContain(
      'anygriddb_source_operation_duration_seconds_count{source="s1",engine="mysql",kind="read",outcome="ok"} 1',
    );
    expect(text).toContain(
      'anygriddb_source_operations_in_flight{source="s1",engine="mysql"} 0',
    );
    expect(text).toContain(
      'anygriddb_job_duration_seconds_count{task="external_sync",outcome="error"} 1',
    );
    expect(text).toContain("anygriddb_process_cpu_seconds_total");
    expect(text).toMatch(
      /^anygriddb_build_info\{version="\d+\.\d+\.\d+[^"]*",commit=""\} 1$/m,
    );
  });
});
