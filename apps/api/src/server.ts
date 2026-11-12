import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import type { Database } from "@anygriddb/db";
import { AppError, ERRORS } from "@anygriddb/core";
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
import { registerClientErrors } from "./client-errors.js";
import { registerCompression } from "./compression.js";
import { authorizeGrid } from "./auth/access.js";
import { passkeysEligible } from "./auth/relying-party.js";
import { registerRateLimit } from "./rate-limit.js";
import { readinessProbe } from "./readiness.js";
import { registerDataTransferRoutes } from "./data-transfer.js";
import { registerMcp } from "./mcp/http.js";
import { registerRestApi } from "./rest-api.js";
import { calendarFeedDocument } from "./data/calendar-feeds.js";
import { queueWebhookRun } from "./automations.js";
import { logUrl } from "./log-url.js";
import { trustProxy } from "./trust-proxy.js";
import { registerScim } from "./scim/routes.js";
import { registerEnterpriseAuth } from "./auth/enterprise.js";
import {
  SESSION_COOKIE,
  findSessionUser,
  hashSessionToken,
  isSessionToken,
  sessionHashAlive,
} from "./auth/session.js";
import type { Env } from "./env.js";
import type { FileStore } from "./files/index.js";
import {
  applyApiSecurityHeaders,
  logFailure,
  publicErrorBody,
  replyFromError,
} from "./http.js";
import type { Context } from "./trpc/context.js";
import { describeTRPCError } from "./trpc/map-error.js";
import { appRouter } from "./trpc/router.js";
import { taskGroups } from "./queue/tasks.js";
import { startQueue } from "./queue/worker.js";
import { HostAllowList } from "./sources/allow-list.js";
import { setSourcePools, SourcePools } from "./sources/pools.js";
import type { SourceSettings } from "./sources/types.js";
import { refreshTls, type TlsState } from "./tls/authority.js";
import { serializeError } from "./logged-error.js";
import { redirectPlainHttp } from "./tls/listener.js";
import { registerWebApp } from "./web-app.js";
import { GridHub, SOCKET_OPTIONS } from "./ws.js";

/** How often the served certificate is checked for renewal or new files. */
const TLS_CHECK_MS = 12 * 3_600_000;
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
    logger: {
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
    (tokenHash) => sessionHashAlive(deps.db, tokenHash),
  );
  const stopHeartbeat = hub.startHeartbeat();
  app.addHook("onClose", () => {
    stopHeartbeat();
  });

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );
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
    }),
    log: app.log.child({ component: "queue" }),
  });
  app.addHook("onClose", async () => {
    await queue.stop();
  });
  await registerCompression(app);
  await registerRateLimit(app);
  await app.register(cookie);
  await app.register(websocket, SOCKET_OPTIONS);
  await registerAttachmentRoutes(app, {
    db: deps.db,
    files: deps.files,
    envMaxBytes: deps.env.ATTACHMENT_MAX_BYTES,
  });

  // HSTS only for a certificate browsers trust on their own: with the
  // instance's authority not yet installed, it would lock people out.
  app.addHook("onRequest", async (request, reply) => {
    applyApiSecurityHeaders(reply, tls?.mode === "operator");
    requestStarted(request, request.method, logUrl(request.url));
  });
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
    if (
      !metricsAllowed(deps.env.METRICS_TOKEN, request.headers.authorization)
    ) {
      return reply.code(deps.env.METRICS_TOKEN ? 401 : 404).send();
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
    { bodyLimit: 65_536 },
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
    if (reply.sent) {
      return;
    }
    reply.code(status).send(body);
  });

  registerClientErrors(app, { publicUrl: deps.env.PUBLIC_URL });
  registerDataTransferRoutes(app, {
    db: deps.db,
    bus: deps.bus,
    files: deps.files,
  });
  registerEnterpriseAuth(app, { env: deps.env, db: deps.db });
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
  registerScim(app, { db: deps.db, publicUrl: deps.env.PUBLIC_URL });

  app.get("/health", () => ({ ok: true }));
  // Up is not ready: a balancer or a monitor asks whether the database
  // answers, and gets 503 while it does not.
  const ready = readinessProbe({
    ping: () => sql`select 1`.execute(deps.db),
    listening: () => deps.bus.listening(),
  });
  app.get("/ready", async (_request, reply) => {
    const state = await ready();
    return reply
      .code(state.ok ? 200 : 503)
      .header("cache-control", "no-store")
      .send(state);
  });

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
          user.id,
          user.displayName,
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
        env: deps.env,
        files: deps.files,
        hub,
        sources,
        tls: () => (tls ? tlsInfo(tls, deps.env.PUBLIC_URL) : null),
      }),
    },
  });

  await registerWebApp(app, deps.webRoot);

  return app;
}
