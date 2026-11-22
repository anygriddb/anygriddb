import { describe, expect, it } from "vitest";
import { MAX_INPUT_DEPTH, nestsPast } from "./input-depth.js";

const nested = (depth: number) => {
  let value: unknown = "leaf";
  for (let level = 0; level < depth; level += 1) {
    value = level % 2 === 0 ? [value] : { conditions: value };
  }
  return value;
};

describe("nestsPast", () => {
  it("takes what a page sends, up to the limit", () => {
    expect(nestsPast({ filter: { conditions: [{ column: "a" }] } })).toBe(
      false,
    );
    expect(nestsPast(nested(MAX_INPUT_DEPTH))).toBe(false);
    expect(nestsPast("text")).toBe(false);
    expect(nestsPast(null)).toBe(false);
  });

  it("refuses one level past it", () => {
    expect(nestsPast(nested(MAX_INPUT_DEPTH + 1))).toBe(true);
  });

  it("survives a value nested deeper than the call stack", () => {
    expect(nestsPast(nested(200_000))).toBe(true);
  });
});
