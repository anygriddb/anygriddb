import { describe, expect, it } from "vitest";
import { compareCodeUnits } from "./text-order";

describe("compareCodeUnits", () => {
  it("orders texts as the default sort does", () => {
    const texts = [
      "b",
      "a",
      "Z",
      "é",
      "z",
      "",
      "a b",
      "😀",
      "\uffff",
      "10",
      "9",
    ];
    expect([...texts].sort(compareCodeUnits)).toEqual([...texts].sort());
    expect(compareCodeUnits("same", "same")).toBe(0);
  });

  it("does not follow a language's order", () => {
    expect(["a", "Z", "é", "z"].sort(compareCodeUnits)).toEqual([
      "Z",
      "a",
      "z",
      "é",
    ]);
  });
});
