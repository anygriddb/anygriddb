import { describe, expect, it } from "vitest";
import { toCell } from "./data-ops.js";

describe("toCell", () => {
  it("turns read values back into writable cells", () => {
    expect(toCell("a")).toBe("a");
    expect(toCell(3)).toBe(3);
    expect(toCell(false)).toBe(false);
    expect(toCell(["x", "y"])).toEqual(["x", "y"]);
    expect(toCell([{ key: "k1", filename: "a.png" }])).toEqual(["k1"]);
  });

  it("drops what a cell cannot hold", () => {
    expect(toCell(undefined)).toBeNull();
    expect(toCell(null)).toBeNull();
    expect(toCell({ nested: true })).toBeNull();
  });
});
