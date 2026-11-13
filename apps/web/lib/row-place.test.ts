import { describe, expect, it } from "vitest";
import { dropPlace, placeBetween } from "./row-place";

describe("dropPlace", () => {
  it("puts a row dropped lower after its target, and higher before it", () => {
    expect(dropPlace(1, 4, "t")).toEqual({ after: "t" });
    expect(dropPlace(6, 4, "t")).toEqual({ before: "t" });
  });

  it("puts a row from another list before its target", () => {
    expect(dropPlace(undefined, 0, "t")).toEqual({ before: "t" });
  });
});

describe("placeBetween", () => {
  it("goes after the row above, or before the row below when first", () => {
    expect(placeBetween("a", "b")).toEqual({ after: "a" });
    expect(placeBetween(undefined, "b")).toEqual({ before: "b" });
  });

  it("has no place without a neighbour", () => {
    expect(placeBetween(undefined, undefined)).toBeNull();
  });
});
