import { AppError } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { oracleSourceError } from "./oracle.js";
import { toOracle } from "./pools.js";

describe("placeholders for Oracle", () => {
  it("bind each place in order, a value repeated or left out as read", () => {
    expect(
      toOracle({
        text: `select '$1', "a$2", $2, $3, $2 from t where y = 'it''s $1'`,
        values: ["one", "two", "three"],
      }),
    ).toEqual({
      text: `select '$1', "a$2", :1, :2, :3 from t where y = 'it''s $1'`,
      values: ["two", "three", "two"],
    });
  });

  it("refuse a place no value fills", () => {
    expect(() =>
      toOracle({ text: "select $2 from dual", values: ["one"] }),
    ).toThrow(AppError);
  });
});

describe("Oracle sign-in errors", () => {
  const failure = (message: string, errorNum?: number) =>
    Object.assign(new Error(message), errorNum ? { errorNum } : {});

  it("say what an administrator can fix", () => {
    expect(
      oracleSourceError(
        failure("ORA-01017: invalid credential or not authorized", 1017),
      ).code,
    ).toBe("source_auth_failed");
    expect(
      oracleSourceError(
        failure(
          "NJS-506: connection to host 127.0.0.1 port 2484 encountered TLS handshake failure.",
        ),
      ).code,
    ).toBe("source_tls_failed");
    expect(
      oracleSourceError(failure("NJS-123: call timeout of 15000 ms exceeded"))
        .code,
    ).toBe("source_timeout");
    expect(
      oracleSourceError(failure("ORA-12514: Cannot connect", 12514)).code,
    ).toBe("source_unknown_database");
  });

  it("keep anything else as unreachable, never as the thick client", () => {
    const unreachable = oracleSourceError(
      failure(
        "NJS-503: connection to host 10.0.0.9 port 1521 could not be established.",
      ),
    );
    expect(unreachable.code).toBe("source_unreachable");
    expect(unreachable.detail).toBeUndefined();
  });
});
