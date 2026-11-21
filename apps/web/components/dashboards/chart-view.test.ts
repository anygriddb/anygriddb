import * as echarts from "echarts/core";
import { describe, expect, it } from "vitest";
import { chartOption, type ChartData } from "./chart-view";

// A chart is drawn by the library from what `chartOption` asks of it. A
// request it cannot place is not refused: it writes "NaN" where a number
// goes, and the browser draws that part at the corner, or not at all.
// These draw each kind of chart as the page does, without a browser, and
// read the drawing.
const context = {
  colors: {
    surface: "#ffffff",
    text: "#111827",
    muted: "#6b7280",
    grid: "#e5e7eb",
    series: [
      "#1f3fae",
      "#b3261e",
      "#0f766e",
      "#a16207",
      "#6d28d9",
      "#be185d",
      "#0369a1",
      "#4d7c0f",
    ],
  },
  format: (value: number | null) => (value === null ? "" : String(value)),
  compact: (value: number) => String(value),
  stacked: true,
  title: "Rows by week",
  dark: false,
};

const weeks = ["2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"];
const one = [{ name: "", values: [4, 6, null, 5] }];
const several = [
  { name: "Idea", values: [2, null, 1, 1] },
  { name: "Draft", values: [null, 1, 2, 2] },
  { name: "Review", values: [2, 1, 1, null] },
];

function data(patch: Partial<ChartData>): ChartData {
  return {
    chartType: "bar",
    fn: "count_all",
    keyTypes: { category: "date", series: null },
    categories: weeks,
    series: one,
    omitted: { categories: 0, series: 0 },
    ...patch,
  };
}

/** The drawing, as the SVG the page would hold. */
function drawn(chart: ChartData, stacked = true): string {
  const instance = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width: 350,
    height: 160,
  });
  instance.setOption({
    ...chartOption(chart, { ...context, stacked }),
    animation: false,
  });
  const svg = instance.renderToSVGString();
  instance.dispose();
  return svg;
}

describe("chartOption", () => {
  it("places everything it draws, whatever the kind of chart", () => {
    const kinds: ChartData["chartType"][] = [
      "bar",
      "bar_horizontal",
      "line",
      "area",
    ];
    for (const chartType of kinds) {
      for (const series of [one, several]) {
        const svg = drawn(data({ chartType, series }));
        expect(
          svg,
          `${chartType}, ${String(series.length)} series`,
        ).not.toContain("NaN");
      }
      // Series set side by side, or of a measure that does not add up.
      const apart = drawn(data({ chartType, series: several }), false);
      expect(apart, `${chartType}, not stacked`).not.toContain("NaN");
    }
    expect(
      drawn(
        data({
          chartType: "pie",
          series: [{ name: "%", values: [50, 30, 20, null] }],
        }),
      ),
    ).not.toContain("NaN");
    expect(
      drawn(
        data({
          chartType: "histogram",
          categories: ["0", "1", "2", "3"],
          bounds: { lo: 0, hi: 40 },
        }),
      ),
    ).not.toContain("NaN");
  });

  it("names each line of several in a legend that can be read", () => {
    for (const chartType of ["line", "area"] as const) {
      const svg = drawn(data({ chartType, series: several }));
      for (const name of ["Idea", "Draft", "Review"]) {
        expect(svg).toContain(`>${name}<`);
      }
      // Each name at a place of its own: three texts, three places.
      const places = [
        ...svg.matchAll(
          /<text[^>]*transform="([^"]+)"[^>]*>(?:Idea|Draft|Review)</g,
        ),
      ].map((match) => match[1]);
      expect(new Set(places).size, chartType).toBe(3);
    }
  });

  it("draws no legend for a single series: its title names it", () => {
    const svg = drawn(
      data({
        chartType: "line",
        series: [{ name: "Rows", values: [1, 2, 3, 4] }],
      }),
    );
    expect(svg).not.toContain(">Rows<");
  });
});
