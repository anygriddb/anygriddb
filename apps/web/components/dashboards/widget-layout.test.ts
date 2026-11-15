import { describe, expect, it } from "vitest";
import { moveWidget, packWidgets, placeWidget } from "./widget-layout";

const chart = { id: "chart", x: 0, y: 0, w: 6, h: 4 };
const metric = { id: "metric", x: 6, y: 0, w: 3, h: 2 };
const view = { id: "view", x: 0, y: 4, w: 12, h: 4 };

describe("moving a dashboard's widgets", () => {
  it("moves a widget a place earlier, the others packed after it", () => {
    expect(moveWidget([chart, metric, view], "metric", -1)).toEqual([
      { id: "metric", x: 0, y: 0, w: 3, h: 2 },
      { id: "chart", x: 3, y: 0, w: 6, h: 4 },
      { id: "view", x: 0, y: 4, w: 12, h: 4 },
    ]);
    expect(moveWidget([chart, metric, view], "metric", 1)).toEqual([
      { id: "chart", x: 0, y: 0, w: 6, h: 4 },
      { id: "view", x: 0, y: 4, w: 12, h: 4 },
      { id: "metric", x: 0, y: 8, w: 3, h: 2 },
    ]);
  });

  it("moves nothing past the first or the last, nor an unknown widget", () => {
    expect(moveWidget([chart, metric, view], "chart", -1)).toBeNull();
    expect(moveWidget([chart, metric, view], "view", 1)).toBeNull();
    expect(moveWidget([chart, metric], "gone", 1)).toBeNull();
  });

  it("puts a widget in another's place and packs the rest", () => {
    expect(placeWidget([chart, metric, view], "view", 0)).toEqual([
      { id: "view", x: 0, y: 0, w: 12, h: 4 },
      { id: "chart", x: 0, y: 4, w: 6, h: 4 },
      { id: "metric", x: 6, y: 4, w: 3, h: 2 },
    ]);
    expect(placeWidget([chart, metric, view], "metric", 0)).toEqual(
      moveWidget([chart, metric, view], "metric", -1),
    );
  });

  it("refuses an index outside the list, the widget's own place, and an unknown widget", () => {
    expect(placeWidget([chart, metric, view], "metric", -1)).toBeNull();
    expect(placeWidget([chart, metric, view], "metric", 3)).toBeNull();
    expect(placeWidget([chart, metric, view], "metric", 1)).toBeNull();
    expect(placeWidget([chart, metric, view], "gone", 0)).toBeNull();
  });

  it("lays out none over another, a widget too wide kept to the grid", () => {
    const packed = packWidgets([
      { id: "a", x: 0, y: 0, w: 8, h: 2 },
      { id: "b", x: 0, y: 0, w: 8, h: 2 },
      { id: "c", x: 0, y: 0, w: 20, h: 2 },
    ]);
    expect(packed.map((widget) => [widget.x, widget.y, widget.w])).toEqual([
      [0, 0, 8],
      [0, 2, 8],
      [0, 4, 12],
    ]);
  });
});
