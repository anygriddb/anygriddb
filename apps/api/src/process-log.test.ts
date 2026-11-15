import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createProcessLog,
  logDestination,
  processLog,
  type ProcessLogLine,
} from "./process-log.js";

const AT = 1_700_000_000_000;

function line(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ time: AT, ...fields })}\n`;
}

function messages(
  log: ReturnType<typeof createProcessLog>,
  level: "info" | "warn" | "error" = "info",
) {
  return log.list({ level, limit: 20 }).map((item) => item.message);
}

describe("the process log", () => {
  it("keeps a warning and a failed request, and drops the rest of the access log", () => {
    const log = createProcessLog();
    log.capture(line({ level: 40, msg: "sources connect without TLS" }));
    log.capture(
      line({
        level: 30,
        msg: "incoming request",
        req: { method: "GET", url: "/health", remoteAddress: "127.0.0.1" },
      }),
    );
    log.capture(
      line({
        level: 30,
        msg: "request completed",
        res: { statusCode: 200 },
        responseTime: 1,
      }),
    );
    log.capture(
      line({
        level: 30,
        msg: "request completed",
        res: { statusCode: 503 },
      }),
    );
    log.capture(line({ level: 20, msg: "parsed the statement" }));
    log.capture(line({ level: 30, msg: "shutting down", reason: "SIGTERM" }));
    expect(messages(log)).toEqual([
      "shutting down",
      "request completed",
      "sources connect without TLS",
    ]);
    const failed = log
      .list({ level: "info", limit: 20 })
      .find((item) => item.message === "request completed");
    expect(failed?.status).toBe(503);
    const stopped = log
      .list({ level: "info", limit: 20 })
      .find((item) => item.message === "shutting down");
    expect(stopped).not.toHaveProperty("reason");
    expect(JSON.stringify(stopped)).not.toContain("SIGTERM");
  });

  it("leaves a secret out of what Administration reads", () => {
    const log = createProcessLog();
    log.capture(
      line({
        level: 50,
        msg: "request failed",
        password: "s3cret-value",
        req: {
          method: "GET",
          url: "/s/super-secret-token?x=1",
          host: "grid.example",
          remoteAddress: "203.0.113.8",
        },
        err: {
          type: "Error",
          code: "internal_error",
          message: "row 42 refused for user@example.org",
          stack: "Error: row 42 refused\n    at read (rows.ts:1:1)",
          constraint: "rows_pkey",
        },
      }),
    );
    const got = log.list({ level: "error", limit: 1 })[0];
    expect(got).toMatchObject({
      message: "request failed",
      level: "error",
      request: { method: "GET", url: "/s/…?…", remoteAddress: "203.0.113.8" },
      error: {
        type: "Error",
        code: "internal_error",
        constraint: "rows_pkey",
        stack: "    at read (rows.ts:1:1)",
      },
    });
    const printed = JSON.stringify(got);
    expect(printed).not.toContain("s3cret-value");
    expect(printed).not.toContain("row 42");
    expect(printed).not.toContain("super-secret");
    expect(printed).not.toContain("grid.example");
    expect(printed).not.toContain("user@example.org");
  });

  it("forgets the oldest line once the ring is full", () => {
    const log = createProcessLog({ maxLines: 2, maxBytes: 1_000_000 });
    log.capture(line({ level: 40, msg: "one" }));
    log.capture(line({ level: 40, msg: "two" }));
    log.capture(line({ level: 40, msg: "three" }));
    expect(messages(log, "warn")).toEqual(["three", "two"]);
  });

  it("forgets the oldest line once the byte ceiling is passed", () => {
    const log = createProcessLog({ maxLines: 50, maxBytes: 220 });
    log.capture(line({ level: 40, msg: "a".repeat(80) }));
    log.capture(line({ level: 40, msg: "b".repeat(80) }));
    const kept = messages(log, "warn");
    expect(kept).toHaveLength(1);
    expect(kept[0]?.startsWith("b")).toBe(true);
  });

  it("assembles a line that arrives in two chunks", () => {
    const log = createProcessLog();
    const text = line({ level: 40, msg: "split" });
    log.capture(text.slice(0, 12));
    expect(log.list({ level: "warn", limit: 5 })).toEqual([]);
    log.capture(text.slice(12));
    expect(messages(log, "warn")).toEqual(["split"]);
  });

  it("records a pool failure without the value the error quoted", () => {
    const log = createProcessLog();
    log.rememberFailure(
      "database connection failed",
      new Error("password=hunter2"),
    );
    const got = log.list({ level: "error", limit: 1 })[0] as ProcessLogLine;
    expect(got.message).toBe("database connection failed");
    expect(got.level).toBe("error");
    expect(got.error?.type).toBe("Error");
    expect(JSON.stringify(got)).not.toContain("hunter2");
    log.rememberFailure("realtime message too large, dropped", undefined);
    const dropped = log
      .list({ level: "error", limit: 5 })
      .find((item) => item.message.startsWith("realtime"));
    expect(dropped?.error).toBeUndefined();
  });

  it("filters by level", () => {
    const log = createProcessLog();
    log.capture(line({ level: 30, msg: "instance settings changed" }));
    log.capture(line({ level: 40, msg: "page failed in a browser" }));
    log.capture(line({ level: 50, msg: "unhandled rejection" }));
    expect(messages(log, "warn")).toEqual([
      "unhandled rejection",
      "page failed in a browser",
    ]);
    expect(messages(log, "error")).toEqual(["unhandled rejection"]);
  });

  it("keeps a browser failure's kind and path, and masks a secret path", () => {
    const log = createProcessLog();
    log.capture(
      line({
        level: 40,
        msg: "page failed in a browser",
        client: {
          kind: "render",
          message: "Cannot read\nproperty",
          path: "/s/abc",
          stack: ["TypeError: secret cell", "    at Page (app.js:1:1)"],
        },
      }),
    );
    const got = log.list({ level: "warn", limit: 1 })[0];
    expect(got?.client).toEqual({
      kind: "render",
      path: "/s/…",
      message: "Cannot read property",
      stack: "    at Page (app.js:1:1)",
    });
    expect(JSON.stringify(got)).not.toContain("secret cell");
  });

  it("receives a line the server logger writes", async () => {
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((_chunk, encoding, cb) => {
        const done = typeof encoding === "function" ? encoding : cb;
        if (typeof done === "function") done();
        return true;
      });
    try {
      const app = Fastify({
        logger: { stream: logDestination(), level: "warn" },
      });
      app.log.warn("fastify ring probe");
      await app.close();
      expect(
        processLog
          .list({ level: "warn", limit: 50 })
          .some((item) => item.message === "fastify ring probe"),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("writes the container's output as well as the ring", () => {
    const log = createProcessLog();
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      logDestination(log).write(line({ level: 40, msg: "tee" }));
      expect(messages(log, "warn")).toEqual(["tee"]);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
