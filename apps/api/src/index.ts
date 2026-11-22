import { purgeParseLeftovers } from "./import-isolated.js";
import {
  createDb,
  migrateDb,
  PostgresTooOld,
  UpgradeRefused,
} from "@anygriddb/db";
import {
  databaseRoleIsSuperuser,
  hasAccounts,
  promoteListedAdmins,
} from "./admin.js";
import { passkeysEligible } from "./auth/relying-party.js";
import { BUILD, describeBuild } from "./build-info.js";
import { databasePasswordHint, isLoopback, readEnv } from "./env.js";
import { createFileStore } from "./files/index.js";
import { watchSyslog } from "./integrations/syslog.js";
import { loggedError, loggedFields } from "./logged-error.js";
import { processLog } from "./process-log.js";
import { metricsBearer } from "./notify/metrics-token.js";
import { migrateQueue } from "./queue/worker.js";
import { PgBus } from "./realtime/bus.js";
import { createApp } from "./server.js";
import {
  registerDatabaseReachableGauge,
  registerDatabaseSizeGauge,
  registerPoolGauge,
  registerQueueGauge,
  watchQueries,
} from "./observability.js";
import { registerSourceLoadWriter } from "./source-load.js";
import {
  applyTracing,
  savedTracing,
  stopCurrentTracing,
} from "./notify/tracing.js";
import { buildFileIndexes } from "./data/file-indexes.js";
import { loadTls, TlsKeyUnreadable } from "./tls/authority.js";
import { listeningText } from "./tls/listener.js";

console.info(`${describeBuild(BUILD)}: starting`);
const env = readEnv();
// HTTPS only (ADR 0029): the operator's certificate, or one from the
// instance's own authority, made at the first start. First of all: a key
// that opens nothing stops here, before the database is changed under it.
const tls = await loadTls(env, (message) => {
  console.warn(message);
}).catch((error: unknown) => {
  if (!(error instanceof TlsKeyUnreadable)) throw error;
  console.error(error.message);
  process.exit(1);
});
const { db, pool, close } = createDb(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  onError: (error) => {
    console.error("database connection failed", loggedError(error));
    processLog.rememberFailure("database connection failed", error);
  },
});
try {
  await migrateDb(pool);
} catch (error) {
  // Nothing was asked of this server: there is nothing to tell it either.
  if (error instanceof PostgresTooOld) {
    console.error(error.message);
    process.exit(1);
  }
  const hint = databasePasswordHint(env.DATABASE_URL, error);
  if (hint) console.error(hint);
  const { notifyMigrationFailure } = await import("./notify/migrate.js");
  await notifyMigrationFailure(db, error);
  // A refusal has just said what to do: no stack to read after it.
  if (error instanceof UpgradeRefused) process.exit(1);
  throw error;
}
// Row writes queue their events in graphile-worker: its schema comes first.
await migrateQueue(env.DATABASE_URL, {
  error: (meta, message) => console.error(message, loggedFields(meta)),
  warn: (meta, message) => console.warn(message, loggedFields(meta)),
  info: () => undefined,
  debug: () => undefined,
});
await promoteListedAdmins(db, env.ADMIN_EMAILS);
// An earlier stack's role still works: told, and left to the operator.
if (await databaseRoleIsSuperuser(db)) {
  console.warn(
    "AnyGridDB signs in to PostgreSQL as a superuser. It works, but a fault in the application would then reach the whole server: docs/operations.md, A stack made before the role was limited.",
  );
}
// Sign-in events also go to the operator's syslog collector, if one is
// named (ADR 0084).
watchSyslog(env.SYSLOG);

// A folder that cannot be written stops the start: better than failing
// on the first upload. A remote S3 service may come up later.
const files = createFileStore(env);
if (files.driver === "disk") await files.check();

// Realtime goes through PostgreSQL: the required stack is PostgreSQL and
// AnyGridDB (ADR 0009).
const bus = new PgBus(pool, env.DATABASE_URL, (error, message) => {
  console.error(message, loggedError(error));
  processLog.rememberFailure(message, error);
});
await bus.start();

// Spans go to the operator's collector, when one is named (ADR 0018, 0092).
const savedTraces = env.OTEL_EXPORTER_OTLP_ENDPOINT
  ? undefined
  : await savedTracing(db, env.AUTH_ENCRYPTION_KEY).catch(() => undefined);
await applyTracing({
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? savedTraces?.endpoint,
  headers: env.OTEL_EXPORTER_OTLP_HEADERS ?? savedTraces?.headers,
  lookup: savedTraces?.lookup,
  serviceName: env.OTEL_SERVICE_NAME,
  version: BUILD.version,
});
registerQueueGauge(db);
registerPoolGauge(pool);
registerSourceLoadWriter(db);
registerDatabaseSizeGauge(db);
registerDatabaseReachableGauge(db);
// Read while the database answers: a first scrape during an outage still
// has the saved token to check.
await metricsBearer(db, env);
watchQueries(pool);
const app = await createApp({ env, db, files, bus, tls });
// A parser of a process that died cleaned nothing up.
await purgeParseLeftovers().catch((error: unknown) => {
  app.log.warn({ err: error }, "could not purge old parser files");
});
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
if (!(await hasAccounts(db))) {
  // The command prints the token; this line never does.
  app.log.info(
    "No account yet. The first one administers the instance and takes a token: run `anygriddb install-token` where the instance runs.",
  );
}
if (files.driver === "s3") {
  await files.check().catch((error: unknown) => {
    app.log.warn({ err: error }, "object storage bucket check failed");
  });
}
await app.listen({
  port: env.PORT,
  host: "0.0.0.0",
  listenTextResolver: listeningText,
});

// Beside the requests, and only once: a build stopped halfway is taken up
// at the next start.
void buildFileIndexes(db, env.DATABASE_URL, app.log).catch((error: unknown) => {
  app.log.error({ err: error }, "file index build failed");
});

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
    await stopCurrentTracing();
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
