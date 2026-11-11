import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from "./sidebar-width";

describe("clampSidebarWidth", () => {
  it("keeps a width inside the allowed range", () => {
    expect(clampSidebarWidth(300)).toBe(300);
    expect(clampSidebarWidth(300.6)).toBe(301);
  });

  it("rejects widths outside the allowed range", () => {
    expect(clampSidebarWidth(SIDEBAR_WIDTH_MIN - 40)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(SIDEBAR_WIDTH_MAX + 40)).toBe(SIDEBAR_WIDTH_MAX);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });
});
