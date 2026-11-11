import { AppError } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { alreadyThere, sideError } from "./enrich.js";

const ora = (errorNum: number) =>
  Object.assign(new Error(`ORA-${String(errorNum).padStart(5, "0")}: …`), {
    errorNum,
  });

describe("side tables on Oracle", () => {
  it("take a table or column left by an earlier attempt", () => {
    expect(alreadyThere(ora(955))).toBe(true);
    expect(alreadyThere(ora(1430))).toBe(true);
    expect(alreadyThere(ora(1031))).toBe(false);
  });

  it("say what the administrator must grant", () => {
    const code = (error: unknown) => {
      const said = sideError(error, "ANYGRIDDB");
      return said instanceof AppError ? said.code : undefined;
    };
    expect(code(ora(1918))).toBe("source_side_missing");
    expect(
      code(new AppError("source_write_denied", { cause: ora(1031) })),
    ).toBe("source_side_denied");
    expect(
      code(new AppError("source_query_failed", { cause: ora(1950) })),
    ).toBe("source_side_denied");
    expect(code(ora(904))).toBeUndefined();
  });
});
