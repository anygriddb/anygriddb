import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "@anygriddb/db";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresDialect,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  routeLabel,
  measureJob,
  measureSource,
  metricsAllowed,
  registerDatabaseReachableGauge,
  registerDatabaseSizeGauge,
  registerPoolGauge,
  registerQueueGauge,
  registerWebsocketGauge,
  registry,
  requestAnswered,
  scrapeReader,
  startTracing,
  watchQueries,
} from "./observability.js";

type OtlpSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
};
type OtlpBody = {
  resourceSpans: Array<{
    resource: {
      attributes: Array<{ key: string; value: { stringValue?: string } }>;
    };
    scopeSpans: Array<{ spans: OtlpSpan[] }>;
  }>;
};

describe("traces", () => {
  it("sends nothing and loads nothing without a collector", async () => {
    const stop = await startTracing({
      endpoint: undefined,
      serviceName: "anygriddb",
      version: "0.0.0",
    });
    expect(await measureJob("quiet", () => Promise.resolve(1))).toBe(1);
    await stop();
  });

  it("sends a collector each span, under the span it ran in", async () => {
    const bodies: OtlpBody[] = [];
    const paths: string[] = [];
    const collector = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
        paths.push(request.url ?? "");
        bodies.push(JSON.parse(raw) as OtlpBody);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => {
      collector.listen(0, "127.0.0.1", resolve);
    });
    const { port } = collector.address() as AddressInfo;
    try {
      const stop = await startTracing({
        endpoint: `http://127.0.0.1:${String(port)}/`,
        serviceName: "anygriddb-test",
        version: "1.2.3",
      });
      await measureJob("outer", () =>
        measureSource({ id: "s1", engine: "postgresql" }, "read", () =>
          Promise.resolve(1),
        ),
      );
      // Stopping sends what the batch still holds.
      await stop();
      expect(paths).toContain("/v1/traces");
      const spans = bodies.flatMap((body) =>
        body.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) => scope.spans),
        ),
      );
      const job = spans.find((span) => span.name === "job outer");
      const read = spans.find((span) => span.name === "source read");
      expect(job).toBeDefined();
      expect(read?.traceId).toBe(job?.traceId);
      expect(read?.parentSpanId).toBe(job?.spanId);
      const attributes = bodies[0]?.resourceSpans[0]?.resource.attributes ?? [];
      expect(
        attributes.find((item) => item.key === "service.name")?.value
          .stringValue,
      ).toBe("anygriddb-test");
    } finally {
      await new Promise<void>((resolve) => {
        collector.close(() => {
          resolve();
        });
      });
    }
  });
});

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

  describe("a read made for a scrape", () => {
    /** A read the test answers by hand. */
    const held = <T>() => {
      let answer: (value: T) => void = () => undefined;
      let refuse: (error: Error) => void = () => undefined;
      const promise = new Promise<T>((resolve, reject) => {
        answer = resolve;
        refuse = reject;
      });
      return { promise, answer, refuse };
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it("gives what the database answered, nothing when it failed", async () => {
      const read = scrapeReader<number>();
      await expect(read(() => Promise.resolve(1))).resolves.toBe(1);
      await expect(
        read(() => Promise.reject(new Error("down"))),
      ).resolves.toBeUndefined();
    });

    it("stops waiting at its limit, and asks once while a read runs", async () => {
      const read = scrapeReader<number>(5);
      const hung = vi.fn(() => new Promise<number>(() => undefined));
      await expect(read(hung)).resolves.toBeUndefined();
      await expect(read(hung)).resolves.toBeUndefined();
      expect(hung).toHaveBeenCalledTimes(1);
    });

    it("gives a slow read's answer to the next scrape", async () => {
      const read = scrapeReader<number>(5);
      const slow = held<number>();
      await expect(read(() => slow.promise)).resolves.toBeUndefined();
      slow.answer(7);
      await slow.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const next = vi.fn(() => new Promise<number>(() => undefined));
      await expect(read(next)).resolves.toBe(7);
      // Two scrapers of one instance both get it.
      await expect(read(next)).resolves.toBe(7);
    });

    it("does not give a late answer once it is old", async () => {
      vi.useFakeTimers();
      const read = scrapeReader<number>(5);
      const slow = held<number>();
      const first = read(() => slow.promise);
      await vi.advanceTimersByTimeAsync(5);
      await first;
      slow.answer(7);
      await vi.advanceTimersByTimeAsync(121_000);
      const second = read(() => new Promise<number>(() => undefined));
      await vi.advanceTimersByTimeAsync(5);
      await expect(second).resolves.toBeUndefined();
    });

    it("does not call a database that stopped answering reachable", async () => {
      const read = scrapeReader<number>(5);
      await expect(read(() => Promise.resolve(1))).resolves.toBe(1);
      await expect(
        read(() => new Promise<number>(() => undefined)),
      ).resolves.toBeUndefined();
    });

    it("drops a late answer when the read after it fails", async () => {
      const read = scrapeReader<number>(5);
      const slow = held<number>();
      await read(() => slow.promise);
      slow.answer(7);
      await slow.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(
        read(() => Promise.reject(new Error("down"))),
      ).resolves.toBeUndefined();
      await expect(
        read(() => new Promise<number>(() => undefined)),
      ).resolves.toBeUndefined();
    });
  });

  describe("the series read from the database", () => {
    const names = [
      "anygriddb_queue_jobs",
      "anygriddb_database_size_bytes",
      "anygriddb_database_reachable",
    ];
    const register = (db: Database) => {
      registerQueueGauge(db);
      registerDatabaseSizeGauge(db);
      registerDatabaseReachableGauge(db);
    };
    afterEach(() => {
      for (const name of names) registry.removeSingleMetric(name);
    });

    it("say the database answers", async () => {
      register(
        new Kysely<never>({
          dialect: {
            createAdapter: () => new PostgresAdapter(),
            createDriver: () => new DummyDriver(),
            createIntrospector: (db) => new PostgresIntrospector(db),
            createQueryCompiler: () => new PostgresQueryCompiler(),
          },
        }) as unknown as Database,
      );
      const text = await registry.metrics();
      expect(text).toContain("anygriddb_database_reachable 1");
      expect(text).toContain('anygriddb_queue_jobs{state="ready"} 0');
    });

    it("leave the scrape standing when it does not", async () => {
      const error = vi.spyOn(console, "error").mockReturnValue();
      register(
        new Kysely<never>({
          dialect: new PostgresDialect({
            pool: {
              connect: () => Promise.reject(new Error("down")),
              end: () => Promise.resolve(),
            } as never,
          }),
        }) as unknown as Database,
      );
      try {
        const text = await registry.metrics();
        expect(text).toContain("anygriddb_database_reachable 0");
        expect(text).toContain("anygriddb_build_info");
        expect(text).not.toContain('anygriddb_queue_jobs{state="ready"}');
        // A second scrape of the same outage says nothing more.
        await registry.metrics();
        expect(error).toHaveBeenCalledTimes(1);
      } finally {
        error.mockRestore();
      }
    });
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

  it("times a query on the product pool without keeping the statement", async () => {
    const pool = {
      query: (text: string) => Promise.resolve(text),
    } as unknown as pg.Pool;
    watchQueries(pool);
    await pool.query("select secret_value");
    const text = await registry.getSingleMetricAsString(
      "anygriddb_db_query_duration_seconds",
    );
    expect(text).toContain("anygriddb_db_query_duration_seconds");
    expect(text).not.toContain("secret_value");
  });

  it("counts open browser sockets", async () => {
    registerWebsocketGauge(() => 2);
    const text = await registry.getSingleMetricAsString(
      "anygriddb_websocket_connections",
    );
    expect(text).toContain("anygriddb_websocket_connections 2");
  });
});
