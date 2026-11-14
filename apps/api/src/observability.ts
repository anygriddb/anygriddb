/**
 * Metrics and traces (ADR 0018). Metrics are Prometheus text on `/metrics`,
 * served only when the operator sets METRICS_TOKEN and only to a request
 * that carries it. Traces are OpenTelemetry spans, made only when the
 * operator names an OTLP endpoint: without one, the tracer does nothing
 * and its SDK is never loaded. Nothing leaves the instance by default.
 */
import { timingSafeEqual } from "node:crypto";
import {
  context,
  type Span,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { BUILD } from "./build-info.js";
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "@prometheus-io/client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "anygriddb_" });

/** Always 1: the running version and commit ride on its labels (ADR 0048). */
new Gauge({
  name: "anygriddb_build_info",
  help: "The AnyGridDB version and commit running.",
  labelNames: ["version", "commit"] as const,
  registers: [registry],
}).set({ version: BUILD.version, commit: BUILD.commit ?? "" }, 1);

const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

const httpRequests = new Counter({
  name: "anygriddb_http_requests_total",
  help: "HTTP requests answered, by route pattern and status class.",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});
const httpDuration = new Histogram({
  name: "anygriddb_http_request_duration_seconds",
  help: "Time to answer an HTTP request, by route pattern.",
  labelNames: ["method", "route"] as const,
  buckets: SECONDS,
  registers: [registry],
});
const procedureDuration = new Histogram({
  name: "anygriddb_trpc_procedure_duration_seconds",
  help: "Time to run a tRPC procedure, by procedure and outcome.",
  labelNames: ["procedure", "outcome"] as const,
  buckets: SECONDS,
  registers: [registry],
});
const sourceDuration = new Histogram({
  name: "anygriddb_source_operation_duration_seconds",
  help: "Time of one read or write transaction in a client's database.",
  labelNames: ["source", "engine", "kind", "outcome"] as const,
  buckets: SECONDS,
  registers: [registry],
});
const sourceInFlight = new Gauge({
  name: "anygriddb_source_operations_in_flight",
  help: "Transactions under way in each client's database: connections in use.",
  labelNames: ["source", "engine"] as const,
  registers: [registry],
});
const jobDuration = new Histogram({
  name: "anygriddb_job_duration_seconds",
  help: "Time to run one background task, by task and outcome.",
  labelNames: ["task", "outcome"] as const,
  buckets: [...SECONDS, 60, 300],
  registers: [registry],
});

const clientErrors = new Counter({
  name: "anygriddb_client_errors_total",
  help: "Failures pages reported from browsers: a page that could not be drawn, an uncaught error, a refused promise.",
  labelNames: ["kind"] as const,
  registers: [registry],
});

/** One failure a page reported (`client-errors.ts`). */
export function clientErrorReported(kind: string): void {
  clientErrors.inc({ kind });
}

/** Jobs waiting, scheduled, running, and failed for good, read at scrape. */
export function registerQueueGauge(db: Database): void {
  new Gauge({
    name: "anygriddb_queue_jobs",
    help: "Background jobs by state: ready, scheduled, running, failed.",
    labelNames: ["state"] as const,
    registers: [registry],
    async collect() {
      const { rows } = await sql<{ state: string; count: string }>`
        select case
            when locked_at is not null then 'running'
            when attempts >= max_attempts then 'failed'
            when run_at <= now() then 'ready'
            else 'scheduled'
          end as state, count(*)::text as count
        from graphile_worker.jobs
        group by 1
      `.execute(db);
      this.reset();
      for (const state of ["ready", "scheduled", "running", "failed"]) {
        const found = rows.find((row) => row.state === state);
        this.set({ state }, Number(found?.count ?? 0));
      }
    },
  });
}

/** What a `pg` pool says of its connections. */
type PoolCounts = {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  options: { max?: number };
};

/** How often the pool is asked how many requests wait for a connection. */
const POOL_SAMPLE_MS = 1_000;

/**
 * The pool every request goes through. Open and idle connections are read
 * at scrape. Requests waiting for a connection are sampled every second,
 * and a scrape gives the most seen since the one before: a wait is over in
 * seconds and would fall between two scrapes, and read at the scrape it
 * would count the scrape's own queries. A number that stays above zero
 * says the pool is too small for the load, or that reads hold their
 * connection too long. Returns what stops the sampling.
 */
export function registerPoolGauge(
  pool: PoolCounts,
  everyMs: number = POOL_SAMPLE_MS,
): () => void {
  let waited = 0;
  const sampler = setInterval(() => {
    waited = Math.max(waited, pool.waitingCount);
  }, everyMs);
  sampler.unref();
  new Gauge({
    name: "anygriddb_db_pool_connections",
    help: "AnyGridDB's own database pool: connections open, connections idle, the most requests seen waiting for one since the last scrape, and the most it opens.",
    labelNames: ["state"] as const,
    registers: [registry],
    collect() {
      this.set({ state: "open" }, pool.totalCount);
      this.set({ state: "idle" }, pool.idleCount);
      this.set({ state: "waiting" }, waited);
      this.set({ state: "max" }, pool.options.max ?? 0);
      waited = 0;
    },
  });
  return () => {
    clearInterval(sampler);
  };
}

/* ------------------------------------------------------------------ */
/* Traces                                                              */
/* ------------------------------------------------------------------ */

let tracer: Tracer = trace.getTracer("anygriddb");

/**
 * Starts sending spans to the operator's OTLP endpoint, or does nothing.
 * The SDK loads only then. Returns what flushes and stops it.
 */
export async function startTracing(settings: {
  endpoint?: string | undefined;
  serviceName: string;
  version: string;
}): Promise<() => Promise<void>> {
  if (!settings.endpoint) return () => Promise.resolve();
  const [{ TracerProvider, BatchSpanProcessor }, contexts, otlp, resources] =
    await Promise.all([
      import("@opentelemetry/sdk-trace"),
      import("@opentelemetry/context-async-hooks"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/resources"),
    ]);
  const provider = new TracerProvider({
    resource: resources.resourceFromAttributes({
      "service.name": settings.serviceName,
      "service.version": settings.version,
    }),
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: new otlp.OTLPTraceExporter({
          url: `${settings.endpoint.replace(/\/$/, "")}/v1/traces`,
        }),
      }),
    ],
  });
  // A span's children are found through the async context Node keeps:
  // without this manager, every span would start a trace of its own.
  const manager = new contexts.AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);
  trace.setGlobalTracerProvider(provider);
  tracer = trace.getTracer("anygriddb", settings.version);
  return async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    tracer = trace.getTracer("anygriddb");
  };
}

/** Runs `body` in a span of its own, child of the active one. */
async function traced<T>(
  name: string,
  attributes: Record<string, string>,
  body: () => Promise<T>,
  parent?: Span,
): Promise<T> {
  const active = parent ? trace.setSpan(context.active(), parent) : undefined;
  const run = (span: Span) =>
    body().then(
      (value) => {
        span.end();
        return value;
      },
      (error: unknown) => {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw error;
      },
    );
  return active
    ? tracer.startActiveSpan(name, { attributes }, active, run)
    : tracer.startActiveSpan(name, { attributes }, run);
}

/* ------------------------------------------------------------------ */
/* What the rest of the API calls                                       */
/* ------------------------------------------------------------------ */

const requestSpans = new WeakMap<object, Span>();

/** An HTTP request starts: its span, which procedures will nest under. */
export function requestStarted(request: object, method: string, url: string) {
  requestSpans.set(
    request,
    tracer.startSpan(`HTTP ${method}`, {
      attributes: { "http.request.method": method, "url.path": url },
    }),
  );
}

/**
 * A route as a label: each built file of the web app is a route of its
 * own, renamed by every build, so they share one.
 */
export function routeLabel(route: string): string {
  if (route.startsWith("/assets/")) return "/assets/*";
  if (
    /\.[a-z0-9]+$/i.test(route) &&
    !route.startsWith("/api/") &&
    !route.startsWith("/trpc/")
  ) {
    return "/static";
  }
  return route;
}

/** An HTTP request was answered, in `seconds`. */
export function requestAnswered(
  request: object,
  input: { method: string; route: string; status: number; seconds: number },
): void {
  const status = `${String(Math.trunc(input.status / 100))}xx`;
  const route = routeLabel(input.route);
  httpRequests.inc({ method: input.method, route, status });
  httpDuration.observe({ method: input.method, route }, input.seconds);
  const span = requestSpans.get(request);
  if (span) {
    span.setAttribute("http.route", input.route);
    span.setAttribute("http.response.status_code", input.status);
    if (input.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    requestSpans.delete(request);
  }
}

/** A tRPC procedure, timed and traced under its request. */
export async function measureProcedure<T extends { ok: boolean }>(
  procedure: string,
  request: object,
  body: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const result = await traced(
    `trpc ${procedure}`,
    { "rpc.method": procedure },
    body,
    requestSpans.get(request),
  );
  procedureDuration.observe(
    { procedure, outcome: result.ok ? "ok" : "error" },
    (performance.now() - started) / 1000,
  );
  return result;
}

/** One transaction in a client's database, timed and traced. */
export async function measureSource<T>(
  source: { id: string; engine: string },
  kind: "read" | "write",
  body: () => Promise<T>,
): Promise<T> {
  const labels = { source: source.id, engine: source.engine };
  const started = performance.now();
  sourceInFlight.inc(labels);
  let outcome = "ok";
  try {
    return await traced(
      `source ${kind}`,
      { "db.system.name": source.engine, "anygriddb.source": source.id },
      body,
    );
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    sourceInFlight.dec(labels);
    sourceDuration.observe(
      { ...labels, kind, outcome },
      (performance.now() - started) / 1000,
    );
  }
}

/** One background task, timed and traced. */
export async function measureJob<T>(
  task: string,
  body: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let outcome = "ok";
  try {
    return await traced(`job ${task}`, { "anygriddb.task": task }, body);
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    jobDuration.observe(
      { task, outcome },
      (performance.now() - started) / 1000,
    );
  }
}

/** True when `header` carries the operator's metrics token. */
export function metricsAllowed(
  token: string | undefined,
  header: string | undefined,
): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
