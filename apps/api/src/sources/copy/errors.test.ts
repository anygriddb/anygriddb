import { AppError } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { connectionError } from "./errors.js";

function coded(code: string, message = code, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code });
}

describe("why a store could not be reached", () => {
  it("is told from the system's code, however deep a driver wraps it", () => {
    expect(connectionError(coded("DEPTH_ZERO_SELF_SIGNED_CERT"))).toMatchObject(
      { code: "source_tls_failed", detail: "DEPTH_ZERO_SELF_SIGNED_CERT" },
    );
    expect(
      connectionError(
        new Error("selection failed", {
          cause: new Error("network", {
            cause: coded("ERR_TLS_CERT_ALTNAME_INVALID"),
          }),
        }),
      )?.code,
    ).toBe("source_tls_failed");
    expect(connectionError(coded("ECONNREFUSED"))?.code).toBe(
      "source_unreachable",
    );
    expect(connectionError(coded("ETIMEDOUT"))?.code).toBe("source_timeout");
    expect(connectionError(coded("ERR_SSL_WRONG_VERSION_NUMBER"))?.code).toBe(
      "source_tls_unavailable",
    );
    // A server that cuts a TLS hello short speaks none.
    expect(
      connectionError(
        coded(
          "ECONNRESET",
          "Client network socket disconnected before secure TLS connection was established",
        ),
      )?.code,
    ).toBe("source_tls_unavailable");
  });

  it("keeps the driver's error as the cause, and none of its words", () => {
    const raised = coded("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.7:27017");
    const error = connectionError(raised);
    expect(error?.cause).toBe(raised);
    expect(error?.message).not.toContain("10.0.0.7");
  });

  it("leaves what it does not know to its caller", () => {
    expect(connectionError(new Error("anything else"))).toBeNull();
    expect(connectionError(coded("E_UNKNOWN"))).toBeNull();
    const known = new AppError("source_auth_failed");
    expect(connectionError(known)).toBe(known);
  });
});
