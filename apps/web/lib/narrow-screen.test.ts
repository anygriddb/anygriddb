import { describe, expect, it } from "vitest";
import { navigationMode } from "./narrow-screen";

describe("navigationMode", () => {
  it("opens the navigation on the page it was opened on", () => {
    expect(navigationMode(true, "/b/1", "/b/1")).toBe("open");
  });

  it("closes it on another page, and never folds it on a wide screen", () => {
    expect(navigationMode(true, "/b/1", "/b/2")).toBe("closed");
    expect(navigationMode(true, null, "/b/1")).toBe("closed");
    expect(navigationMode(false, "/b/1", "/b/1")).toBe("docked");
    expect(navigationMode(false, null, "/b/1")).toBe("docked");
  });
});
