import { describe, expect, it } from "vitest";
import { chartSeries, histogramSeries } from "./dashboards.js";

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
    const result = chartSeries(columns, { groupBy: "stage", fn: "count_all" }, [
      { key: "Lost", series: undefined, value: 1 },
      { key: null, series: undefined, value: 2 },
      { key: "Lead", series: undefined, value: "3" },
    ]);
    expect(result.categories).toEqual(["Lead", "Lost", "(vide)"]);
    expect(result.series).toEqual([{ name: "", values: [3, 1, 2] }]);
  });

  it("orders categories by their value, greatest first, and keeps the first ones", () => {
    const sold = [
      { key: "Lead", series: undefined, value: "5" },
      { key: "Won", series: undefined, value: "40" },
      { key: "Lost", series: undefined, value: "12.5" },
      { key: "Open", series: undefined, value: null },
    ];
    const byValue = chartSeries(
      columns,
      { groupBy: "stage", fn: "sum", order: "value" },
      sold,
    );
    // The one without a value is last, whatever its name.
    expect(byValue.categories).toEqual(["Won", "Lost", "Lead", "Open"]);
    expect(byValue.series).toEqual([{ name: "", values: [40, 12.5, 5, null] }]);
    const firstTwo = chartSeries(
      columns,
      { groupBy: "stage", fn: "sum", order: "value", limit: 2 },
      sold,
    );
    expect(firstTwo.categories).toEqual(["Won", "Lost"]);
    expect(firstTwo.omitted.categories).toBe(2);
    // Without an order, the first of the field's own.
    const own = chartSeries(
      columns,
      { groupBy: "stage", fn: "sum", limit: 2 },
      sold,
    );
    expect(own.categories).toEqual(["Lead", "Won"]);
  });

  it("weighs a category by its series together, or by the greatest when the measure does not add up", () => {
    const pairs = [
      { key: "Lead", series: "a", value: 6 },
      { key: "Lead", series: "b", value: 6 },
      { key: "Won", series: "a", value: 10 },
      { key: "Won", series: "b", value: 1 },
    ];
    const summed = chartSeries(
      columns,
      { groupBy: "stage", seriesBy: "owner", fn: "sum", order: "value" },
      pairs,
    );
    expect(summed.categories).toEqual(["Lead", "Won"]);
    const meant = chartSeries(
      columns,
      { groupBy: "stage", seriesBy: "owner", fn: "avg", order: "value" },
      pairs,
    );
    expect(meant.categories).toEqual(["Won", "Lead"]);
  });

  it("never draws more categories than a chart holds, whatever is asked", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      key: `k${String(index)}`,
      series: undefined,
      value: index,
    }));
    const result = chartSeries(
      columns,
      { groupBy: "owner", fn: "sum", order: "value", limit: 500 },
      many,
    );
    expect(result.categories).toHaveLength(40);
    expect(result.categories[0]).toBe("k59");
    expect(result.omitted.categories).toBe(20);
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
    const result = chartSeries(columns, { groupBy: "stage", fn: "sum" }, [
      { key: "Won", series: undefined, value: null },
    ]);
    expect(result.series).toEqual([{ name: "", values: [null] }]);
  });
});

describe("a histogram's bins", () => {
  it("are in their order, a bin no row fell in drawn at zero", () => {
    expect(
      histogramSeries(
        [
          { bin: 3, rows: "2" },
          { bin: "0", rows: 5 },
        ],
        4,
      ),
    ).toEqual({
      categories: ["0", "1", "2", "3"],
      series: [{ name: "", values: [5, 0, 0, 2] }],
      omitted: { categories: 0, series: 0 },
    });
  });

  it("are none without a value to count, and what is no number is left out", () => {
    expect(histogramSeries([], 0)).toEqual({
      categories: [],
      series: [{ name: "", values: [] }],
      omitted: { categories: 0, series: 0 },
    });
    expect(
      histogramSeries(
        [
          { bin: null, rows: 4 },
          { bin: 0, rows: "many" },
          { bin: 0, rows: 1 },
        ],
        1,
      ).series[0]?.values,
    ).toEqual([1]);
  });
});
