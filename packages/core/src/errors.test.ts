import { describe, expect, it } from "vitest";
import {
  AppError,
  ERROR_CODES,
  ERRORS,
  isErrorCode,
  publicError,
} from "./errors";

describe("public errors", () => {
  it("joins the detail to the English message, and keeps the cause", () => {
    const cause = new Error("pg: relation missing");
    const error = new AppError("unknown_column", "prix", { cause });
    expect(error.message).toBe("Unknown column: prix");
    expect(error.status).toBe(400);
    expect(error.cause).toBe(cause);
    expect(new AppError("invalid_import", { cause }).message).toBe(
      "Invalid import",
    );
    expect(new AppError("row_locked").status).toBe(409);
  });

  it("tells a client the code and detail, and nothing of an internal error", () => {
    expect(publicError(new AppError("unknown_field", "Prix"))).toEqual({
      code: "unknown_field",
      detail: "Prix",
      message: "Unknown field: Prix",
    });
    expect(publicError(new Error("ECONNREFUSED 10.0.0.3:5432"))).toEqual({
      code: "internal_error",
      message: "Internal error",
    });
  });

  it("gives every code one message and a status a client can act on", () => {
    const messages = ERROR_CODES.map((code) => ERRORS[code][1]);
    expect(new Set(messages).size).toBe(messages.length);
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
      expect([400, 401, 403, 404, 409, 412, 413, 429, 500, 503]).toContain(
        ERRORS[code][0],
      );
    }
    expect(isErrorCode("unknown_table")).toBe(true);
    expect(isErrorCode("toString")).toBe(false);
  });
});
