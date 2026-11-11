import { createDb, migrateDb } from "@anygriddb/db";
import { promoteListedAdmins } from "./admin.js";
import { passkeysEligible } from "./auth/relying-party.js";
import { BUILD, describeBuild } from "./build-info.js";
import { isLoopback, readEnv } from "./env.js";
import { createFileStore } from "./files/index.js";
import { migrateQueue } from "./queue/worker.js";
import { PgBus } from "./realtime/bus.js";
import { createApp } from "./server.js";
import {
  registerPoolGauge,
  registerQueueGauge,
  startTracing,
} from "./observability.js";
import { loadTls } from "./tls/authority.js";

console.info(`${describeBuild(BUILD)}: starting`);
const env = readEnv();
const { db, pool, close } = createDb(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  onError: (error) => {
    console.error("database connection failed", error);
  },
});
await migrateDb(pool);
// Row writes queue their events in graphile-worker: its schema comes first.
await migrateQueue(env.DATABASE_URL, {
  error: (meta, message) => console.error(message, meta),
  warn: (meta, message) => console.warn(message, meta),
  info: () => undefined,
  debug: () => undefined,
});
await promoteListedAdmins(db, env.ADMIN_EMAILS);

// A folder that cannot be written stops the start: better than failing
// on the first upload. A remote S3 service may come up later.
const files = createFileStore(env);
if (files.driver === "disk") await files.check();

// Realtime goes through PostgreSQL: the required stack is PostgreSQL and
// AnyGridDB (ADR 0009).
const bus = new PgBus(pool, env.DATABASE_URL, (error, message) => {
  console.error(message, error);
});
await bus.start();

// HTTPS only (ADR 0029): the operator's certificate, or one from the
// instance's own authority, made at the first start.
const tls = await loadTls(env, (message) => {
  console.warn(message);
});
// Spans go to the operator's collector, when one is named (ADR 0018).
const stopTracing = await startTracing({
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  serviceName: env.OTEL_SERVICE_NAME,
  version: BUILD.version,
});
registerQueueGauge(db);
registerPoolGauge(pool);
const app = await createApp({ env, db, files, bus, tls });
if (tls.authority) {
  app.log.info(
    {
      fingerprint: tls.authority.fingerprint,
      names: tls.authority.names,
      download: `${env.PUBLIC_URL}/tls/authority.crt`,
    },
    "TLS: the instance's own authority signs the certificate. Install it once on each workstation, after checking its SHA-256 fingerprint, and browsers trust AnyGridDB without a warning.",
  );
}
if (
  new URL(env.PUBLIC_URL).protocol === "http:" &&
  isLoopback(new URL(env.PUBLIC_URL).hostname)
) {
  app.log.warn(
    "PUBLIC_URL is a plain HTTP address on this machine: the development server's. The API itself serves HTTPS.",
  );
}
if (!passkeysEligible(env.PUBLIC_URL)) {
  app.log.warn(
    {
      publicUrl: env.PUBLIC_URL,
    },
    "PUBLIC_URL is an IP address: HTTPS and TOTP work; passkeys need a DNS hostname (or localhost) in PUBLIC_URL that people open. Put the IP in TLS_NAMES if it must stay on the certificate (ADR 0029).",
  );
}
if (files.driver === "s3") {
  await files.check().catch((error: unknown) => {
    app.log.warn({ err: error }, "object storage bucket check failed");
  });
}
await app.listen({ port: env.PORT, host: "0.0.0.0" });

let shuttingDown = false;
const shutdown = async (reason: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ reason }, "shutting down");
  // A close that never ends (a request held open, a database that does
  // not answer) must not keep the process: the supervisor starts another.
  const force = setTimeout(() => {
    app.log.error("shutdown timed out; exiting");
    process.exit(1);
  }, 20_000);
  force.unref();
  try {
    await app.close();
    await stopTracing();
    await bus.close();
    await close();
  } finally {
    clearTimeout(force);
  }
};

process.on("SIGINT", () => {
  void shutdown("SIGINT").finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM").finally(() => process.exit(0));
});
process.on("unhandledRejection", (error) => {
  app.log.error({ err: error }, "unhandled rejection");
  void shutdown("unhandledRejection").finally(() => process.exit(1));
});
process.on("uncaughtException", (error) => {
  app.log.error({ err: error }, "uncaught exception");
  void shutdown("uncaughtException").finally(() => process.exit(1));
});
