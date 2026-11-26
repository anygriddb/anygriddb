import { registerActingRequests } from "./acting-requests.js";
import { budgetFor } from "./read-budget.js";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { migrationNames, type Database } from "@anygriddb/db";
import { AppError, ERRORS, mapTileOrigin } from "@anygriddb/core";
import { TRPCError } from "@trpc/server";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import {
  metricsAllowed,
  registry,
  requestAnswered,
  requestStarted,
} from "./observability.js";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { sql } from "kysely";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { Bus } from "./realtime/bus.js";
import { registerAttachmentRoutes } from "./attachments.js";
import { uploadSlots } from "./upload-slots.js";
import { registerClientErrors } from "./client-errors.js";
import { registerLogoRoute } from "./instance-logo.js";
import { registerCompression } from "./compression.js";
import { registerTextGuard } from "./text-guard.js";
import { authorizeGrid, gridChannelRights } from "./auth/access.js";
import { passkeysEligible } from "./auth/relying-party.js";
import { rateBucket, registerRateLimit } from "./rate-limit.js";
import { pruneRateWindows, rateStoreIn } from "./rate-store.js";
import { metricsBearer } from "./notify/metrics-token.js";
import { registerWebsocketGauge } from "./observability.js";
import { migrationsCurrent, readinessProbe } from "./readiness.js";
import { registerDataTransferRoutes } from "./data-transfer.js";
import { registerMcp } from "./mcp/http.js";
import { registerAdminApi } from "./admin-api.js";
import { registerRestApi } from "./rest-api.js";
import { calendarFeedDocument } from "./data/calendar-feeds.js";
import { shareEmbedOriginsForToken } from "./data/sharing.js";
import { queueWebhookRun } from "./automations.js";
import { logUrl } from "./log-url.js";
import { logDestination } from "./process-log.js";
import { trustProxy } from "./trust-proxy.js";
import { registerOauth } from "./oauth/routes.js";
import { registerScim } from "./scim/routes.js";
import { registerEnterpriseAuth } from "./auth/enterprise.js";
import {
  findSessionUser,
  hashSessionToken,
  isSessionToken,
  SESSION_COOKIE,
  sessionIdentities,
} from "./auth/session.js";
import type { Env } from "./env.js";
import type { FileStore } from "./files/index.js";
import {
  acceptFormBodies,
  applyApiSecurityHeaders,
  foreignSessionWrite,
  logFailure,
  publicErrorBody,
  refuseAsUnknownAddress,
  refuseBeforeHooks,
  replyFromError,
  sayWhenToRetry,
  unservedProcedureMethod,
} from "./http.js";
import type { Context } from "./trpc/context.js";
import { describeTRPCError } from "./trpc/map-error.js";
import { appRouter } from "./trpc/router.js";
import { taskGroups } from "./queue/tasks.js";
import { startQueue } from "./queue/worker.js";
import { HostAllowList } from "./sources/allow-list.js";
import { setSourcePools, SourcePools } from "./sources/pools.js";
import type { SourceSettings } from "./sources/types.js";
import { refreshTls, TLS_CHECK_MS, type TlsState } from "./tls/authority.js";
import { serializeError } from "./logged-error.js";
import { redirectPlainHttp } from "./tls/listener.js";
import { readGateSettings } from "./settings.js";
import { registerWebApp } from "./web-app.js";
import { GridHub, SOCKET_OPTIONS } from "./ws.js";

/** Messages a page may send before its session is looked up. */
const MAX_EARLY_MESSAGES = 64;

/** What administrators are shown of the certificate served. */
export type TlsInfo = {
  mode: TlsState["mode"];
  server: TlsState["server"];
  authority: Omit<NonNullable<TlsState["authority"]>, "cert"> | null;
  /**
   * Whether `PUBLIC_URL` can be a WebAuthn RP ID (hostname or localhost).
   * An IP-only origin keeps HTTPS and TOTP; passkeys stay off (ADR 0029).
   */
  passkeysEligible: boolean;
};

function tlsInfo(state: TlsState, publicUrl: string): TlsInfo {
  const { cert: _cert, ...authority } = state.authority ?? { cert: "" };
  return {
    mode: state.mode,
    server: state.server,
    authority: state.authority ? (authority as TlsInfo["authority"]) : null,
    passkeysEligible: passkeysEligible(publicUrl),
  };
}

export async function createApp(deps: {
  env: Env;
  files: FileStore;
  db: Database;
  bus: Bus;
  /** The built web app; `apps/web/dist` unless told otherwise. */
  webRoot?: string;
  /**
   * The certificate to serve (ADR 0029). The started server always has
   * one; tests that only inject requests leave it out.
   */
  tls?: TlsState;
}) {
  let tls = deps.tls;
  let secure: Server | undefined;
  const app = Fastify({
    ...(tls
      ? {
          // HTTPS only; plain HTTP on the same port gets a redirect.
          serverFactory: (handler: Parameters<typeof createHttpsServer>[1]) => {
            secure = createHttpsServer(
              {
                key: tls?.key,
                cert: tls?.cert,
                minVersion: "TLSv1.2",
              },
              handler,
            );
            redirectPlainHttp(secure);
            return secure;
          },
        }
      : {}),
    trustProxy: trustProxy(deps.env.TRUSTED_PROXIES),
    // tRPC batches queries into one path, `a.b,a.b,…`: past Fastify's 100
    // characters a page of five widgets was answered 414. The web client
    // keeps a whole URL under 6,000 characters.
    routerOptions: { maxParamLength: 6_000 },
    frameworkErrors: (error, _request, reply) => {
      refuseBeforeHooks(error, reply, tls?.mode === "operator");
    },
    logger: {
      // A second copy of each line, for Administration (ADR 0087). The
      // stream still writes the container's output, which a collector reads.
      stream: logDestination(),
      redact: [
        "req.headers.cookie",
        "req.headers.authorization",
        "res.headers['set-cookie']",
      ],
      // Addresses can hold secrets (a share's, a feed's, a webhook's) and
      // tRPC inputs: logs keep the path, masked where it is a secret.
      serializers: {
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: logUrl(request.url),
          host: request.host,
          remoteAddress: request.ip,
        }),
        // An error's kind, code and frames: never its message or what it
        // carried (an address, a row). Every `{ err }` goes through here.
        err: serializeError,
      },
    },
  });
  // Read once at start: an entry the operator mistyped stops the API here.
  const allowList = new HostAllowList(deps.env.SOURCES_ALLOWED_HOSTS);
  const sources: SourceSettings = {
    allows: (host) => allowList.allows(host),
    allowedHosts: allowList.entries,
    allowPlaintext: deps.env.SOURCES_ALLOW_PLAINTEXT,
  };
  if (sources.allowPlaintext) {
    app.log.warn(
      "ANYGRIDDB_SOURCES_ALLOW_PLAINTEXT is on: sources connect without TLS. For development only.",
    );
  }
  // Reads of exposed tables open one pool per source, closed with the app.
  const pools = new SourcePools({
    db: deps.db,
    key: deps.env.AUTH_ENCRYPTION_KEY,
    settings: sources,
    log: (error, message) => {
      app.log.error({ err: error }, message);
    },
  });
  setSourcePools(pools);
  app.addHook("onClose", async () => {
    setSourcePools(undefined);
    await pools.close();
  });
  const hub = new GridHub(
    deps.bus,
    deps.db,
    (userId, channel, action) =>
      authorizeGrid(deps.db, userId, channel, action),
    (level, error, message) => {
      if (level === "warn") {
        app.log.warn(message);
        return;
      }
      app.log.error({ err: error }, message);
    },
    (tokenHashes) => sessionIdentities(deps.db, tokenHashes),
    (wanted) => gridChannelRights(deps.db, wanted),
  );
  registerWebsocketGauge(() => hub.connections());
  const stopHeartbeat = hub.startHeartbeat();
  app.addHook("onClose", () => {
    stopHeartbeat();
  });

  acceptFormBodies(app);
  const queue = await startQueue({
    connectionString: deps.env.DATABASE_URL,
    groups: taskGroups({
      db: deps.db,
      bus: deps.bus,
      env: deps.env,
      files: deps.files,
      log: (error, message) => {
        app.log.error({ err: error }, message);
      },
      certificateExpires: () => tls?.server.expires ?? null,
    }),
    log: app.log.child({ component: "queue" }),
  });
  app.addHook("onClose", async () => {
    await queue.stop();
  });
  await registerCompression(app);
  await registerRateLimit(app, {
    store: rateStoreIn(deps.db, {
      warn: (error) => {
        app.log.warn({ err: error }, "requests not counted");
      },
    }),
    prune: (timeWindow) => pruneRateWindows(deps.db, timeWindow),
    values: async () => (await readGateSettings(deps.db)).limits,
  });
  await app.register(cookie);
  await app.register(websocket, SOCKET_OPTIONS);
  // Uploads read at once, whatever they are: each is written to local
  // disk as it arrives.
  const uploads = uploadSlots(deps.env.UPLOAD_CONCURRENCY);
  await registerAttachmentRoutes(app, {
    db: deps.db,
    files: deps.files,
    encryptionKey: deps.env.AUTH_ENCRYPTION_KEY,
    envMaxBytes: deps.env.ATTACHMENT_MAX_BYTES,
    uploads,
  });
  registerLogoRoute(app, { db: deps.db });

  // HSTS only for a certificate browsers trust on their own: with the
  // instance's authority not yet installed, it would lock people out.
  app.addHook("onRequest", async (request, reply) => {
    applyApiSecurityHeaders(reply, tls?.mode === "operator");
    requestStarted(request, request.method, logUrl(request.url));
  });
  // A write or a socket that carries a session comes from the app's own
  // pages, or is refused before anything reads it.
  app.addHook("onRequest", async (request, reply) => {
    if (
      foreignSessionWrite(request, {
        sessionCookie: SESSION_COOKIE,
        publicUrl: deps.env.PUBLIC_URL,
        exempt: ["/auth/saml/acs"],
      })
    ) {
      request.log.warn("a session's write from another origin refused");
      return reply.code(403).send(publicErrorBody(403));
    }
  });
  app.addHook("onRequest", async (request, reply) => {
    if (unservedProcedureMethod(request)) {
      return reply
        .code(405)
        .header("allow", "GET, POST")
        .send(publicErrorBody(405));
    }
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    sayWhenToRetry(reply, payload);
  });
  registerActingRequests(app, deps.db);
  registerTextGuard(app);
  // Requests by route pattern, never by path: ids would explode the series.
  app.addHook("onResponse", async (request, reply) => {
    requestAnswered(request, {
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      status: reply.statusCode,
      seconds: reply.elapsedTime / 1000,
    });
  });
  // Prometheus text for the operator's token only (ADR 0018); without a
  // token, there is nothing here.
  app.get("/metrics", async (request, reply) => {
    const token = await metricsBearer(deps.db, deps.env);
    if (!metricsAllowed(token, request.headers.authorization)) {
      return reply.code(token ? 401 : 404).send();
    }
    return reply
      .header("content-type", registry.contentType)
      .header("cache-control", "no-store")
      .send(await registry.metrics());
  });

  // A webhook automation's address: its token is its secret. A JSON body
  // of 64 KiB at most; any other answer is the same 404.
  app.post<{ Params: { token: string } }>(
    "/hooks/automations/:token",
    {
      bodyLimit: 65_536,
      errorHandler: (error, _request, reply) => {
        refuseAsUnknownAddress(error, reply);
      },
    },
    async (request, reply) => {
      const queued = await queueWebhookRun(
        deps.db,
        request.params.token,
        request.body,
      );
      return queued
        ? reply.code(202).send({ queued: true })
        : reply.code(404).header("cache-control", "no-store").send();
    },
  );

  // A private calendar feed (iCal): its address is its secret, and a
  // feed that cannot be read answers 404 whatever the reason.
  app.get<{ Params: { token: string } }>(
    "/ical/:token",
    async (request, reply) => {
      const document = await calendarFeedDocument(
        deps.db,
        request.params.token.replace(/\.ics$/, ""),
        deps.env.PUBLIC_URL,
        new Date(),
        budgetFor(reply.raw),
      );
      if (!document) {
        return reply.code(404).header("cache-control", "no-store").send();
      }
      return reply
        .header("content-type", "text/calendar; charset=utf-8")
        .header("cache-control", "private, max-age=300")
        .header("referrer-policy", "no-referrer")
        .send(document);
    },
  );

  if (tls) {
    const timer = setInterval(() => {
      if (!tls) return;
      void refreshTls(deps.env, tls, (message) => app.log.warn(message))
        .then((next) => {
          if (next === tls) return;
          tls = next;
          secure?.setSecureContext({ key: next.key, cert: next.cert });
          app.log.info(
            {
              fingerprint: next.server.fingerprint,
              expires: next.server.expires,
            },
            "TLS certificate renewed",
          );
        })
        .catch((error: unknown) => {
          app.log.error({ err: error }, "TLS certificate check failed");
        });
    }, TLS_CHECK_MS);
    timer.unref();
    app.addHook("onClose", () => {
      clearInterval(timer);
    });
    // The authority people install, before they can sign in: public.
    app.get("/tls/authority.crt", (_request, reply) => {
      const authority = tls?.authority;
      if (!authority) {
        return reply.code(404).send(publicErrorBody(404));
      }
      return reply
        .type("application/x-x509-ca-cert")
        .header(
          "Content-Disposition",
          'attachment; filename="anygriddb-authority.crt"',
        )
        .send(authority.cert);
    });
  }

  app.setErrorHandler((error: unknown, request, reply) => {
    // A refusal the server named (an AppError) keeps its code and its
    // status; so does one Fastify raised. Anything else is a fault.
    const { status, body } = replyFromError(error);
    logFailure(request.log, {
      error,
      status,
      message: "request failed",
      ...(error instanceof AppError ? { context: { code: error.code } } : {}),
    });
    if (status >= 500) {
      void import("./notify/sentry.js")
        .then(({ captureServerError }) =>
          captureServerError(deps.db, deps.env.AUTH_ENCRYPTION_KEY),
        )
        .catch((reportError: unknown) => {
          request.log.error({ err: reportError }, "error report failed");
        });
    }
    if (reply.sent) {
      return;
    }
    // A sign-on is a page the browser is on: it is told on the sign-in
    // page, not shown a body of JSON.
    if (
      status === 429 &&
      rateBucket(request.method, request.url) === "signOn" &&
      !request.url.startsWith("/auth/oidc/backchannel-logout")
    ) {
      void reply.redirect("/login?refused=too_many_attempts", 303);
      return;
    }
    reply.code(status).send(body);
  });

  registerClientErrors(app, { publicUrl: deps.env.PUBLIC_URL });
  registerDataTransferRoutes(app, {
    db: deps.db,
    bus: deps.bus,
    files: deps.files,
    uploads,
    rowsFixed: deps.env,
  });
  registerEnterpriseAuth(app, {
    env: deps.env,
    db: deps.db,
    closeSession: (tokenHash) => hub.closeSession(tokenHash),
  });
  registerRestApi(app, {
    db: deps.db,
    bus: deps.bus,
    publicUrl: deps.env.PUBLIC_URL,
  });
  registerMcp(app, {
    db: deps.db,
    bus: deps.bus,
    publicUrl: deps.env.PUBLIC_URL,
  });
  registerScim(app, {
    db: deps.db,
    publicUrl: deps.env.PUBLIC_URL,
    bus: deps.bus,
  });
  registerOauth(app, { db: deps.db, publicUrl: deps.env.PUBLIC_URL });
  registerAdminApi(app, {
    db: deps.db,
    env: deps.env,
    closeUser: (userId) => hub.closeUser(userId),
  });

  app.get("/health", () => ({ ok: true }));
  app.get("/healthz", () => ({ ok: true }));
  // Up is not ready: a balancer or a monitor asks whether the database
  // answers, and gets 503 while it does not. `/ready` stays that check.
  // `/readyz` also requires every migration this process knows.
  const ping = () => sql`select 1`.execute(deps.db);
  const listening = () => deps.bus.listening();
  const ready = readinessProbe({ ping, listening });
  const readyWithMigrations = readinessProbe({
    ping,
    listening,
    migrations: async () => {
      const expected = await migrationNames();
      const applied = await sql<{ name: string }>`
        select name from schema_migrations
      `.execute(deps.db);
      return migrationsCurrent(
        applied.rows.map((row) => row.name),
        expected,
      );
    },
  });
  const sendReady = async (
    probe: () => Promise<{ ok: boolean }>,
    reply: FastifyReply,
  ) => {
    const state = await probe();
    return reply
      .code(state.ok ? 200 : 503)
      .header("cache-control", "no-store")
      .send(state);
  };
  app.get("/ready", async (_request, reply) => sendReady(ready, reply));
  app.get("/readyz", async (_request, reply) =>
    sendReady(readyWithMigrations, reply),
  );

  app.get("/ws", { websocket: true }, (socket, request) => {
    // The page subscribes as soon as the link opens, before its session is
    // looked up. A message no handler takes is lost: what it sends
    // meanwhile is held, within a bound (ADR 0049).
    const early: unknown[] = [];
    const hold = (raw: unknown) => {
      if (early.length >= MAX_EARLY_MESSAGES) {
        socket.close(1008, "Too many messages");
        return;
      }
      early.push(raw);
    };
    socket.on("message", hold);
    const sessionToken = request.cookies[SESSION_COOKIE];
    void findSessionUser(deps.db, sessionToken)
      .then((user) => {
        socket.off("message", hold);
        if (!user || !isSessionToken(sessionToken)) {
          request.log.warn("access denied");
          socket.close(4401, "Unauthorized");
          return;
        }
        if (socket.readyState !== socket.OPEN) return;
        hub.add(
          socket,
          user.actingAs?.id ?? user.id,
          user.actingAs?.displayName || user.displayName,
          early,
          hashSessionToken(sessionToken),
        );
      })
      .catch((error: unknown) => {
        socket.off("message", hold);
        request.log.error({ err: error }, "websocket session lookup failed");
        socket.close(1011, "Internal error");
      });
  });

  await app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      // A page sends its calls together; the web client stops at 50 a
      // request (`apps/web/lib/trpc.ts`). Nothing sends more.
      maxBatchSize: 100,
      onError({
        error,
        path,
        type,
        ctx,
      }: {
        error: unknown;
        path: string | undefined;
        type: string;
        ctx: Context | undefined;
      }) {
        if (!ctx) return;
        const code =
          error instanceof TRPCError
            ? describeTRPCError(error).code
            : "internal_error";
        logFailure(ctx.req.log, {
          error,
          status: ERRORS[code][0],
          message: "trpc failed",
          context: { path, type, code },
        });
      },
      createContext: ({
        req,
        res,
      }: {
        req: FastifyRequest;
        res: FastifyReply;
      }): Context => ({
        db: deps.db,
        bus: deps.bus,
        req,
        res,
        readBudget: budgetFor(res.raw),
        env: deps.env,
        files: deps.files,
        hub,
        sources,
        tls: () => (tls ? tlsInfo(tls, deps.env.PUBLIC_URL) : null),
      }),
    },
  });

  await registerWebApp(app, deps.webRoot, {
    shareEmbedOrigins: (token) => shareEmbedOriginsForToken(deps.db, token),
    tileOrigin: async () => mapTileOrigin(await readGateSettings(deps.db)),
  });

  return app;
}
