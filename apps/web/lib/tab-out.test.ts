import { describe, expect, it } from "vitest";
import { pickOutside, type Place } from "./tab-out";

// The page's controls in order: two before the grid, three it holds (its
// field menus, the line that adds a row), two after it.
const page: Array<[string, Place]> = [
  ["search", "before"],
  ["more actions", "before"],
  ["field menu", "inside"],
  ["field menu 2", "inside"],
  ["add a row", "inside"],
  ["record panel", "after"],
  ["footer", "after"],
];
const placeOf = (control: [string, Place]) => control[1];

describe("pickOutside", () => {
  it("reaches the first control after the grid, past those it holds", () => {
    expect(pickOutside(page, placeOf, false)?.[0]).toBe("record panel");
  });

  it("reaches the last control before the grid, going back", () => {
    expect(pickOutside(page, placeOf, true)?.[0]).toBe("more actions");
  });

  it("goes round the page where it has nothing on that side", () => {
    const last = page.filter(([, place]) => place !== "after");
    expect(pickOutside(last, placeOf, false)?.[0]).toBe("search");
    const first = page.filter(([, place]) => place !== "before");
    expect(pickOutside(first, placeOf, true)?.[0]).toBe("footer");
  });

  it("finds nothing on a page whose only controls are the grid's", () => {
    const alone = page.filter(([, place]) => place === "inside");
    expect(pickOutside(alone, placeOf, false)).toBeUndefined();
    expect(pickOutside(alone, placeOf, true)).toBeUndefined();
  });
});
