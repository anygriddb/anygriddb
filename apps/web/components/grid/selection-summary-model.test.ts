import { describe, expect, it } from "vitest";
import { summarizeSelection } from "./selection-summary-model";

describe("selection summary", () => {
  it("sums decimals exactly and counts the filled cells", () => {
    const summary = summarizeSelection([
      { value: "0.1", numeric: true },
      { value: "0.2", numeric: true },
      { value: -1, numeric: true },
      { value: "Acme", numeric: false },
      { value: null, numeric: true },
    ]);
    // 0.1 + 0.2 is 0.3, not 0.30000000000000004.
    expect(summary).toMatchObject({
      cells: 5,
      filled: 4,
      numbers: 3,
      sum: "-0.7",
      min: "-1",
      max: "0.2",
    });
    expect(summary.mean).toBeCloseTo(-0.2333, 3);
  });

  it("leaves out text in a number column and lists", () => {
    const summary = summarizeSelection([
      { value: "n/a", numeric: true },
      { value: ["a", "b"], numeric: true },
      { value: [], numeric: false },
    ]);
    expect(summary).toEqual({ cells: 3, filled: 2, numbers: 0 });
  });
});
