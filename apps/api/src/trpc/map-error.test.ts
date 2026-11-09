import { AppError } from "@anygriddb/core";
import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import type { Context } from "./context.js";
import { procedure, t } from "./init.js";
import { describeTRPCError, mapProcedureError } from "./map-error.js";

const router = t.router({
  locked: procedure.query(() => {
    throw new AppError("row_locked");
  }),
  broken: procedure.query(() => {
    throw new Error("relation t_x does not exist");
  }),
});

async function failure(call: () => Promise<unknown>): Promise<TRPCError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof TRPCError) return error;
  }
  throw new Error("expected a tRPC error");
}

describe("tRPC errors", () => {
  const caller = t.createCallerFactory(router)({} as Context);

  it("sends a public error thrown anywhere with its status and code", async () => {
    const error = await failure(() => caller.locked());
    expect(error.code).toBe("CONFLICT");
    expect(describeTRPCError(error)).toEqual({
      code: "row_locked",
      message: "Row locked",
    });
  });

  it("tells nothing of an internal error", async () => {
    const error = await failure(() => caller.broken());
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(describeTRPCError(error)).toEqual({
      code: "internal_error",
      message: "Internal error",
    });
  });

  it("logs refusals as warnings and failures as errors", () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    expect(() => mapProcedureError(new AppError("access_denied"), log)).toThrow(
      "Access denied",
    );
    expect(log.warn).toHaveBeenCalledWith("access denied");
    expect(() => mapProcedureError(new Error("boom"), log)).toThrow(
      "Internal error",
    );
    expect(log.error).toHaveBeenCalledOnce();
    expect(
      describeTRPCError(new TRPCError({ code: "UNAUTHORIZED" })).code,
    ).toBe("unauthenticated");
  });
});
