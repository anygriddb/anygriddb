import { describe, expect, it } from "vitest";
import { addDays, barDragValues, draggedDays } from "./timeline-drag";

const start = (value: string | null, withTime = false) => ({
  name: "start",
  withTime,
  value,
});
const end = (value: string | null, withTime = false) => ({
  name: "due",
  withTime,
  value,
});

describe("draggedDays", () => {
  it("counts the days a pointer crossed, to the nearest", () => {
    expect(draggedDays(79, 40)).toBe(2);
    expect(draggedDays(-61, 40)).toBe(-2);
  });

  it("counts none for a move shorter than half a day", () => {
    expect(draggedDays(19, 40)).toBe(0);
    expect(draggedDays(-1, 4)).toBe(0);
  });
});

describe("addDays", () => {
  it("crosses months, years, and a change of clocks", () => {
    expect(addDays("2026-11-29", 3)).toBe("2026-12-02");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
  });
});

describe("barDragValues", () => {
  it("moves both dates by the middle", () => {
    expect(
      barDragValues({
        grip: "move",
        days: 2,
        start: start("2026-11-16"),
        end: end("2026-11-27"),
      }),
    ).toEqual({ start: "2026-11-18", due: "2026-11-29" });
  });

  it("moves one date by its edge, and stops it at the other", () => {
    const bar = { start: start("2026-11-16"), end: end("2026-11-19") };
    expect(barDragValues({ grip: "start", days: -3, ...bar })).toEqual({
      start: "2026-11-13",
    });
    expect(barDragValues({ grip: "start", days: 9, ...bar })).toEqual({
      start: "2026-11-19",
    });
    expect(barDragValues({ grip: "end", days: -9, ...bar })).toEqual({
      due: "2026-11-16",
    });
    expect(barDragValues({ grip: "end", days: 1, ...bar })).toEqual({
      due: "2026-11-20",
    });
  });

  it("gives a bar without an end one by its right edge", () => {
    const bar = { start: start("2026-11-16"), end: end(null) };
    expect(barDragValues({ grip: "end", days: 2, ...bar })).toEqual({
      due: "2026-11-18",
    });
    expect(barDragValues({ grip: "move", days: 2, ...bar })).toEqual({
      start: "2026-11-18",
    });
    expect(barDragValues({ grip: "start", days: 2, ...bar })).toEqual({
      start: "2026-11-18",
    });
  });

  it("keeps the time a date field holds", () => {
    const at = new Date(2026, 10, 16, 14, 30).toISOString();
    const values = barDragValues({
      grip: "move",
      days: 1,
      start: start(at, true),
    });
    expect(new Date(values?.start ?? "")).toEqual(
      new Date(2026, 10, 17, 14, 30),
    );
  });

  it("writes nothing when nothing moves, or when there is nothing to move", () => {
    const bar = { start: start("2026-11-16"), end: end("2026-11-16") };
    expect(barDragValues({ grip: "move", days: 0, ...bar })).toBeNull();
    // An edge already at the other one.
    expect(barDragValues({ grip: "start", days: 3, ...bar })).toBeNull();
    expect(barDragValues({ grip: "end", days: -3, ...bar })).toBeNull();
    // No end field: the right edge holds nothing.
    expect(
      barDragValues({ grip: "end", days: 2, start: start("2026-11-16") }),
    ).toBeNull();
    // No start: the bar is not drawn.
    expect(
      barDragValues({ grip: "move", days: 2, start: start(null) }),
    ).toBeNull();
  });

  it("draws a bar ending before it starts from its first day", () => {
    const bar = { start: start("2026-11-16"), end: end("2026-11-10") };
    expect(barDragValues({ grip: "end", days: 2, ...bar })).toEqual({
      due: "2026-11-18",
    });
  });
});
