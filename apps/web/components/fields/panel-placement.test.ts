import { describe, expect, it } from "vitest";
import { panelPlacement } from "./panel-placement";

const SCREEN = { top: 0, left: 0, right: 1440, bottom: 900 };
const PANEL = { width: 288, height: 320 };

describe("panelPlacement", () => {
  it("opens from the cell's top left corner when there is room", () => {
    const cell = { top: 112, left: 600, right: 780, bottom: 144 };
    expect(panelPlacement(cell, PANEL, SCREEN)).toEqual({
      x: "start",
      y: "below",
    });
  });

  it("aligns on the cell's right edge in the last column", () => {
    const cell = { top: 112, left: 1206, right: 1386, bottom: 144 };
    expect(panelPlacement(cell, PANEL, SCREEN).x).toBe("end");
  });

  it("opens upward near the bottom of what can be seen", () => {
    const cell = { top: 800, left: 600, right: 780, bottom: 832 };
    expect(panelPlacement(cell, PANEL, SCREEN).y).toBe("above");
  });

  it("stays put when the other side has no more room", () => {
    // A narrow, short window: neither side fits, the panel keeps its place.
    const small = { top: 0, left: 0, right: 300, bottom: 200 };
    const cell = { top: 100, left: 100, right: 200, bottom: 132 };
    expect(panelPlacement(cell, PANEL, small)).toEqual({
      x: "start",
      y: "below",
    });
  });

  it("reads the box that clips the grid, not only the window", () => {
    const grid = { top: 80, left: 240, right: 1024, bottom: 900 };
    const cell = { top: 112, left: 776, right: 906, bottom: 144 };
    expect(panelPlacement(cell, PANEL, grid).x).toBe("end");
  });
});
