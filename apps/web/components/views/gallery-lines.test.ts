import { describe, expect, it } from "vitest";
import { cardsOf } from "./gallery-lines";

describe("cardsOf", () => {
  it("places a line's cards after the lines above it", () => {
    expect(cardsOf(0, 3, 10)).toEqual([0, 1, 2]);
    expect(cardsOf(2, 3, 10)).toEqual([6, 7, 8]);
  });

  it("stops at the last card", () => {
    expect(cardsOf(3, 3, 10)).toEqual([9]);
    expect(cardsOf(4, 3, 10)).toEqual([]);
    expect(cardsOf(0, 4, 0)).toEqual([]);
  });
});
