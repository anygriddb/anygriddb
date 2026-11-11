import { describe, expect, it } from "vitest";
import { AppError } from "@anygriddb/core";
import {
  applyApiSecurityHeaders,
  logFailure,
  publicErrorBody,
  publicErrorStatus,
  replyFromError,
  stripCrlf,
} from "./http.js";

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
    const lines: Array<[string, Record<string, unknown>, string]> = [];
    const log = {
      error: (object: Record<string, unknown>, message: string) =>
        lines.push(["error", object, message]),
      info: (object: Record<string, unknown>, message: string) =>
        lines.push(["info", object, message]),
    };
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
    const lines: Array<[string, Record<string, unknown>, string]> = [];
    const log = {
      error: (object: Record<string, unknown>, message: string) =>
        lines.push(["error", object, message]),
      info: (object: Record<string, unknown>, message: string) =>
        lines.push(["info", object, message]),
    };
    logFailure(log, {
      error: { statusCode: 429, error: "Too many requests" },
      status: 429,
      message: "request failed",
    });
    expect(lines).toEqual([["info", { status: 429 }, "request failed"]]);
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
