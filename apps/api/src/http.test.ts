import { describe, expect, it } from "vitest";
import {
  applyApiSecurityHeaders,
  publicErrorBody,
  publicErrorStatus,
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
});
