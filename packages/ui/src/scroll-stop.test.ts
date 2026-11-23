import { describe, expect, it } from "vitest";
import { needsTabStop } from "./scroll-stop";

function area(scrollHeight: number, clientHeight: number, focusable: boolean) {
  return {
    scrollHeight,
    clientHeight,
    querySelector: () => (focusable ? ({} as Element) : null),
  };
}

describe("needsTabStop", () => {
  it("stops on an area that overflows with nothing to focus", () => {
    expect(needsTabStop(area(900, 400, false))).toBe(true);
  });

  it("adds no stop to an area that fits", () => {
    expect(needsTabStop(area(400, 400, false))).toBe(false);
  });

  it("adds no stop to an area whose own controls take the keyboard", () => {
    expect(needsTabStop(area(900, 400, true))).toBe(false);
  });
});
