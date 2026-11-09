import { describe, expect, it } from "vitest";
import { chartSeries } from "./dashboards.js";

const columns = [
  {
    name: "stage",
    fieldType: "single_select",
    config: { options: [{ name: "Lead" }, { name: "Won" }, { name: "Lost" }] },
  },
  { name: "owner", fieldType: "text", config: {} },
] as unknown as Parameters<typeof chartSeries>[0];

/** Ten owners over two stages, owner n weighing n. */
const rows = Array.from({ length: 10 }, (_, index) => [
  { key: "Won", series: `o${String(index + 1)}`, value: String(index + 1) },
  { key: "Lead", series: `o${String(index + 1)}`, value: index + 1 },
]).flat();

describe("chart series", () => {
  it("orders categories as the select's options, then naturally", () => {
    const result = chartSeries(
      columns,
      { groupBy: "stage", fn: "count_all" },
      [
        { key: "Lost", series: undefined, value: 1 },
        { key: null, series: undefined, value: 2 },
        { key: "Lead", series: undefined, value: "3" },
      ],
    );
    expect(result.categories).toEqual(["Lead", "Lost", "(vide)"]);
    expect(result.series).toEqual([{ name: "", values: [3, 1, 2] }]);
  });

  it("folds the smallest series into one when the measure adds up", () => {
    const result = chartSeries(
      columns,
      { groupBy: "stage", seriesBy: "owner", fn: "sum" },
      rows,
    );
    // Kept by weight, shown in natural order.
    expect(result.series.map((item) => item.name)).toEqual([
      "o4",
      "o5",
      "o6",
      "o7",
      "o8",
      "o9",
      "o10",
      "(autres)",
    ]);
    // o1, o2, and o3 add up to 6 in each stage.
    expect(result.series.at(-1)?.values).toEqual([6, 6]);
    expect(result.omitted).toEqual({ categories: 0, series: 0 });
  });

  it("leaves series out, and says so, when the measure does not add up", () => {
    const result = chartSeries(
      columns,
      { groupBy: "stage", seriesBy: "owner", fn: "avg" },
      rows,
    );
    expect(result.series).toHaveLength(7);
    expect(result.omitted.series).toBe(3);
  });

  it("draws nothing for a group whose values are all empty", () => {
    const result = chartSeries(
      columns,
      { groupBy: "stage", fn: "sum" },
      [{ key: "Won", series: undefined, value: null }],
    );
    expect(result.series).toEqual([{ name: "", values: [null] }]);
  });
});
