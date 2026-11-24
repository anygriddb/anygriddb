import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { AppError } from "@anygriddb/core";
import {
  applyApiSecurityHeaders,
  foreignSessionWrite,
  logFailure,
  publicErrorBody,
  publicErrorStatus,
  refuseAsUnknownAddress,
  refuseBeforeHooks,
  replyFromError,
  sayWhenToRetry,
  stripCrlf,
  unservedProcedureMethod,
} from "./http.js";

/** A logger that keeps each line it is given, with its level. */
function recordingLog() {
  const lines: Array<[string, Record<string, unknown>, string]> = [];
  const log = {
    error: (object: Record<string, unknown>, message: string) =>
      lines.push(["error", object, message]),
    info: (object: Record<string, unknown>, message: string) =>
      lines.push(["info", object, message]),
  };
  return { lines, log };
}

describe("API security headers", () => {
  it("sends clickjacking and content-type headers, and HSTS only on HTTPS", () => {
    const headers = new Map<string, string>();
    const reply = {
      header: (name: string, value: string) => headers.set(name, value),
    };

    applyApiSecurityHeaders(reply, false);
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers.has("Strict-Transport-Security")).toBe(false);

    applyApiSecurityHeaders(reply, true);
    expect(headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("strips line breaks and hides server exceptions from clients", () => {
    expect(stripCrlf("ada@example.com\r\nINFO forged")).toBe(
      "ada@example.comINFO forged",
    );
    expect(publicErrorStatus(404)).toBe(404);
    expect(publicErrorStatus(undefined)).toBe(500);
    expect(publicErrorBody(500)).toEqual({
      error: "Internal error",
      code: "internal_error",
    });
    expect(publicErrorBody(400)).toEqual({
      error: "Request rejected",
      code: "request_rejected",
    });
    expect(publicErrorBody(400, "invalid_snapshot")).toEqual({
      error: "Invalid snapshot",
      code: "invalid_snapshot",
    });
  });

  it("logs a server fault as an error, with its stack", () => {
    const { lines, log } = recordingLog();
    const fault = new Error("connection reset");
    logFailure(log, {
      error: fault,
      status: 500,
      message: "trpc failed",
      context: { path: "rows.read" },
    });
    expect(lines).toEqual([
      ["error", { path: "rows.read", err: fault }, "trpc failed"],
    ]);
  });

  it("keeps a refused request off the errors, on one line", () => {
    const { lines, log } = recordingLog();
    logFailure(log, {
      error: { statusCode: 429, error: "Too many requests" },
      status: 429,
      message: "request failed",
    });
    expect(lines).toEqual([["info", { status: 429 }, "request failed"]]);
  });

  it("keeps a read its client left off the errors", () => {
    const { lines, log } = recordingLog();
    logFailure(log, {
      error: new AppError("request_closed"),
      status: 499,
      message: "trpc failed",
      context: { path: "rows.read", code: "request_closed" },
    });
    expect(lines).toEqual([
      [
        "info",
        { path: "rows.read", code: "request_closed", status: 499 },
        "trpc failed",
      ],
    ]);
  });

  it("keeps AppError codes on the Fastify error path", () => {
    const refused = replyFromError(new AppError("access_denied"));
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      error: "Access denied",
      code: "access_denied",
    });
    const unknown = replyFromError(new Error("boom"));
    expect(unknown.status).toBe(500);
    expect(unknown.body.code).toBe("internal_error");
    const fastify = replyFromError({ statusCode: 404, message: "missing" });
    expect(fastify.status).toBe(404);
    expect(fastify.body.code).toBe("not_found");
  });
});

describe("a session's write from another origin", () => {
  const input = {
    sessionCookie: "__Host-ag_session",
    publicUrl: "https://grid.example.org",
    exempt: ["/auth/saml/acs"],
  };
  const session = "theme=dark; __Host-ag_session=abc";
  const write = (
    headers: Record<string, string | string[]>,
    more: { method?: string; url?: string } = {},
  ) =>
    foreignSessionWrite(
      {
        method: more.method ?? "POST",
        url: more.url ?? "/trpc/rows.insert",
        headers: { host: "grid.example.org", cookie: session, ...headers },
      },
      input,
    );

  it("lets the app's own pages write, by either of its addresses", () => {
    // The address people are told to open, and the one the request was
    // sent to: another name of the certificate, or a port.
    expect(write({ origin: "https://grid.example.org" })).toBe(false);
    expect(
      write({ origin: "https://10.0.0.5:3000", host: "10.0.0.5:3000" }),
    ).toBe(false);
    // Behind a proxy that names its own upstream as the host.
    expect(
      write({ origin: "https://grid.example.org", host: "app:4000" }),
    ).toBe(false);
  });

  it("lets the development server's pages write, by any of its names", () => {
    const development = { ...input, publicUrl: "http://localhost:3000" };
    const from = (origin: string) =>
      foreignSessionWrite(
        {
          method: "POST",
          url: "/trpc/rows.insert",
          headers: { host: "localhost:4000", cookie: session, origin },
        },
        development,
      );
    expect(from("http://localhost:3000")).toBe(false);
    expect(from("http://127.0.0.1:3000")).toBe(false);
    expect(from("http://wiki.example.org")).toBe(true);
    // Not where the instance is served over HTTPS.
    expect(write({ origin: "http://localhost:3000" })).toBe(true);
  });

  it("refuses a page of the same site on another name or port", () => {
    expect(write({ origin: "https://wiki.example.org" })).toBe(true);
    expect(write({ origin: "https://grid.example.org:8443" })).toBe(true);
    expect(write({ origin: "http://grid.example.org" })).toBe(true);
    expect(write({ origin: "null" })).toBe(true);
    expect(write({ origin: ["https://a.example", "https://b.example"] })).toBe(
      true,
    );
    // A socket is opened with a GET.
    expect(
      write(
        { origin: "https://wiki.example.org", upgrade: "WebSocket" },
        { method: "GET", url: "/ws" },
      ),
    ).toBe(true);
  });

  it("leaves alone what is no write of a session from a page", () => {
    const foreign = { origin: "https://wiki.example.org" };
    // A read: its answer is not for a page of another origin to see.
    expect(write(foreign, { method: "GET" })).toBe(false);
    // No session: a token, a public link, a sign-in.
    expect(write({ ...foreign, cookie: "theme=dark" })).toBe(false);
    expect(write({ ...foreign, cookie: "x__Host-ag_session=abc" })).toBe(false);
    // No page: a script, a command.
    expect(write({})).toBe(false);
    // The identity provider's answer, which may come from the same site.
    expect(write(foreign, { url: "/auth/saml/acs?x=1" })).toBe(false);
  });
});

describe("a method no procedure answers", () => {
  it("lets a query, a mutation, and a HEAD through", () => {
    for (const method of ["GET", "POST", "HEAD"]) {
      expect(
        unservedProcedureMethod({ method, url: "/trpc/session.current" }),
      ).toBe(false);
    }
  });

  it("refuses any other under /trpc, TRACE among them, and nothing elsewhere", () => {
    for (const method of ["TRACE", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(
        unservedProcedureMethod({ method, url: "/trpc/session.current" }),
      ).toBe(true);
      expect(unservedProcedureMethod({ method, url: "/trpc/nope" })).toBe(true);
      // The REST API has its own routes for these.
      expect(
        unservedProcedureMethod({ method, url: "/api/v1/tables/x/records" }),
      ).toBe(false);
    }
  });
});

describe("an answer of 'not now'", () => {
  const answer = (statusCode: number, sent: Record<string, string> = {}) => {
    const headers = new Map(Object.entries(sent));
    sayWhenToRetry({
      statusCode,
      hasHeader: (name) => headers.has(name.toLowerCase()),
      header: (name, value) => {
        headers.set(name.toLowerCase(), value);
      },
    });
    return headers.get("retry-after");
  };

  it("says when to ask again", () => {
    expect(answer(503)).toBe("30");
  });

  it("keeps what its route said, and says nothing on any other answer", () => {
    expect(answer(503, { "retry-after": "5" })).toBe("5");
    for (const status of [200, 400, 429, 500, 504]) {
      expect(answer(status)).toBeUndefined();
    }
  });

  it("reads the status of an answer handed whole, which the reply has not taken yet", () => {
    const whole = (status: number, headers: Record<string, string> = {}) => {
      const said = new Map<string, string>();
      sayWhenToRetry(
        {
          // What a reply holds until the answer is sent.
          statusCode: 200,
          hasHeader: (name) => said.has(name.toLowerCase()),
          header: (name, value) => {
            said.set(name.toLowerCase(), value);
          },
        },
        new Response(null, { status, headers }),
      );
      return said.get("retry-after");
    };
    expect(whole(503)).toBe("30");
    expect(whole(503, { "Retry-After": "5" })).toBeUndefined();
    expect(whole(200)).toBeUndefined();
    expect(whole(207)).toBeUndefined();
  });
});

describe("a request refused before any hook", () => {
  const server = () => {
    const app = Fastify({
      frameworkErrors: (error, _request, reply) => {
        refuseBeforeHooks(error, reply, true);
      },
    });
    // As the server does for every request a route answers.
    app.addHook("onRequest", async (_request, reply) => {
      applyApiSecurityHeaders(reply, true);
    });
    app.get("/known", () => ({ ok: true }));
    return app;
  };

  it("answers an address it cannot read as any other refusal, headers included", async () => {
    const app = server();
    for (const url of ["/%", "/trpc/%3Cscript%3E%"]) {
      const refused = await app.inject({ url });
      expect(refused.statusCode).toBe(400);
      // Neither the framework's code nor the path that was sent.
      expect(refused.json()).toEqual({
        error: "Request rejected",
        code: "request_rejected",
      });
      expect(refused.headers["x-content-type-options"]).toBe("nosniff");
      expect(refused.headers["x-frame-options"]).toBe("DENY");
      expect(refused.headers["content-security-policy"]).toContain(
        "default-src 'none'",
      );
      expect(refused.headers["strict-transport-security"]).toBeDefined();
    }
  });

  it("leaves an address it can read to its route", async () => {
    const known = await server().inject({ url: "/known" });
    expect(known.statusCode).toBe(200);
    expect(known.json()).toEqual({ ok: true });
  });
});

describe("a route whose address is its secret", () => {
  const server = () => {
    const app = Fastify();
    app.post(
      "/hooks/:token",
      {
        bodyLimit: 64,
        errorHandler: (error, _request, reply) => {
          refuseAsUnknownAddress(error, reply);
        },
      },
      (request, reply) => {
        const { token } = request.params as { token: string };
        if (token === "fault") throw new Error("the database is away");
        return token === "known"
          ? reply.code(202).send({ queued: true })
          : reply.code(404).header("cache-control", "no-store").send();
      },
    );
    return app;
  };
  const post = (
    app: ReturnType<typeof server>,
    token: string,
    payload: string,
    type = "application/json",
  ) =>
    app.inject({
      method: "POST",
      url: `/hooks/${token}`,
      headers: { "content-type": type },
      payload,
    });

  it("answers a body refused before the secret is read as an unknown address", async () => {
    const app = server();
    const unknown = await post(app, "unknown", "{}");
    for (const refused of [
      await post(app, "unknown", JSON.stringify({ x: "y".repeat(100) })),
      await post(app, "unknown", "{not json"),
      await post(app, "unknown", "x", "application/x-other"),
      // The same for the address that is one: the body is read first.
      await post(app, "known", "{not json"),
    ]) {
      expect(refused.statusCode).toBe(404);
      expect(refused.body).toBe(unknown.body);
      expect(refused.headers["cache-control"]).toBe("no-store");
    }
  });

  it("takes a body it can read, and keeps a fault of the server one", async () => {
    const app = server();
    expect((await post(app, "known", "{}")).statusCode).toBe(202);
    expect((await post(app, "fault", "{}")).statusCode).toBe(500);
  });
});
