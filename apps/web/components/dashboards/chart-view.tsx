/**
 * A dashboard chart drawn with Apache ECharts (ADR 0035), loaded with the
 * dashboards only. Colours come from the theme's validated series tokens,
 * read again when the theme changes; marks follow fixed specs (bars at
 * most 24 px with a rounded data end, 2 px lines, a 2 px surface gap
 * between stacked segments); every value is also in a table view.
 */
import { BarChart, LineChart } from "echarts/charts";
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import { useLingui } from "@lingui/react/macro";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AriaComponent,
  SVGRenderer,
]);

export type ChartData = {
  chartType: "bar" | "bar_horizontal" | "line" | "area" | "pie";
  fn: string;
  /** The grouped fields' types: their keys read in the reader's language. */
  keyTypes: { category: string | null; series: string | null };
  categories: string[];
  series: Array<{ name: string; values: Array<number | null> }>;
  omitted: { categories: number; series: number };
};

/** Aggregates that add up: their series stack. */
const ADDITIVE = new Set([
  "count_all",
  "count_empty",
  "count_filled",
  "sum",
  "checked",
  "unchecked",
]);
const PERCENT = new Set([
  "percent_empty",
  "percent_filled",
  "percent_unique",
  "percent_checked",
  "percent_unchecked",
]);

/** The theme, as the root element says it: charts read their colours again. */
function useThemeName(): string {
  return useSyncExternalStore(
    (notify) => {
      const observer = new MutationObserver(notify);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      return () => observer.disconnect();
    },
    () => document.documentElement.dataset.theme ?? "light",
  );
}

function tokens() {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    surface: read("--ag-card"),
    text: read("--ag-foreground"),
    muted: read("--ag-muted-foreground"),
    grid: read("--ag-border"),
    series: Array.from({ length: 8 }, (_, index) =>
      read(`--ag-series-${String(index + 1)}`),
    ),
  };
}

/** Names come from people's data: never HTML in a tooltip. */
function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Each category's share of the total, largest first: the "pie" chart. */
function shares(data: ChartData): ChartData {
  const totals = data.categories.map((_, index) =>
    data.series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0),
  );
  const all = totals.reduce((sum, value) => sum + value, 0);
  const order = data.categories
    .map((name, index) => ({ name, value: totals[index] ?? 0 }))
    .sort((left, right) => right.value - left.value);
  return {
    ...data,
    categories: order.map((item) => item.name),
    series: [
      {
        name: "%",
        values: order.map((item) =>
          all === 0 ? null : Math.round((item.value / all) * 1000) / 10,
        ),
      },
    ],
  };
}

export function ChartView(props: { data: ChartData; title: string }) {
  const { t, i18n } = useLingui();
  const ref = useRef<HTMLDivElement>(null);
  const theme = useThemeName();
  // The same values as a table, in the chart's place: never squeezed.
  const [asTable, setAsTable] = useState(false);
  const pie = props.data.chartType === "pie";
  // A group's key as the reader reads it: a checkbox's yes or no, a date in
  // their language, an empty group named so.
  const keyLabel = useMemo(() => {
    const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium" });
    return (key: string, fieldType: string | null) => {
      if (key === "(vide)") return t`(empty)`;
      if (fieldType === "boolean") {
        return key === "true" ? t`Yes` : key === "false" ? t`No` : key;
      }
      if (
        (fieldType === "date" ||
          fieldType === "datetime" ||
          fieldType === "created_time" ||
          fieldType === "last_modified_time") &&
        /^\d{4}-\d{2}-\d{2}/.test(key)
      ) {
        return dates.format(new Date(`${key.slice(0, 10)}T12:00:00Z`));
      }
      return key;
    };
  }, [i18n.locale, t]);
  const data = useMemo(() => {
    const named: ChartData = {
      ...props.data,
      categories: props.data.categories.map((key) =>
        keyLabel(key, props.data.keyTypes.category),
      ),
      series: props.data.series.map((item) => ({
        ...item,
        name: keyLabel(item.name, props.data.keyTypes.series),
      })),
    };
    return pie ? shares(named) : named;
  }, [pie, props.data, keyLabel]);
  const percent = pie || PERCENT.has(props.data.fn);
  const format = useMemo(() => {
    const plain = new Intl.NumberFormat(i18n.locale, {
      maximumFractionDigits: 2,
    });
    return (value: number | null) =>
      value === null ? "—" : `${plain.format(value)}${percent ? " %" : ""}`;
  }, [i18n.locale, percent]);
  const compact = useMemo(() => {
    const short = new Intl.NumberFormat(i18n.locale, {
      notation: "compact",
      maximumFractionDigits: 1,
    });
    return (value: number) =>
      `${Math.abs(value) >= 10_000 ? short.format(value) : new Intl.NumberFormat(i18n.locale).format(value)}${percent ? " %" : ""}`;
  }, [i18n.locale, percent]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const chart = echarts.init(node, null, { renderer: "svg" });
    const resize = new ResizeObserver(() => chart.resize());
    resize.observe(node);
    return () => {
      resize.disconnect();
      chart.dispose();
    };
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const chart = echarts.getInstanceByDom(node);
    if (!chart) return;
    chart.setOption(
      option(data, {
        colors: tokens(),
        format,
        compact,
        stacked: ADDITIVE.has(data.fn) && !pie,
        title: props.title,
        // A change of theme sets the option again: colours are read anew.
        dark: theme === "dark",
      }),
      true,
    );
  }, [data, format, compact, pie, props.title, theme]);

  const single = data.series.length === 1;
  return (
    <div className="flex h-full min-h-0 flex-col gap-1">
      <div ref={ref} className={asTable ? "hidden" : "min-h-0 flex-1"} />
      {asTable ? (
        <div className="min-h-0 flex-1 overflow-auto text-xs">
          <table className="w-full text-left tabular-nums">
            <thead className="sticky top-0 bg-card">
              <tr>
                <th scope="col" className="py-1 pr-2 font-medium">
                  {t`Category`}
                </th>
                {data.series.map((item) => (
                  <th
                    key={item.name}
                    scope="col"
                    className="py-1 pr-2 text-right font-medium"
                  >
                    {single ? props.title : item.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.categories.map((category, index) => (
                <tr key={category} className="border-t border-border">
                  <th scope="row" className="py-1 pr-2 font-normal">
                    {category}
                  </th>
                  {data.series.map((item) => (
                    <td key={item.name} className="py-1 pr-2 text-right">
                      {format(item.values[index] ?? null)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <button
          type="button"
          className="underline-offset-2 hover:text-foreground hover:underline"
          aria-pressed={asTable}
          onClick={() => setAsTable(!asTable)}
        >
          {asTable ? t`Show the chart` : t`Show the table of values`}
        </button>
        {props.data.omitted.categories > 0 ? (
          <span>
            {t`${{ count: props.data.omitted.categories }} more categories are not shown.`}
          </span>
        ) : null}
        {props.data.omitted.series > 0 ? (
          <span>
            {t`${{ count: props.data.omitted.series }} more series are not shown.`}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function option(
  data: ChartData,
  context: {
    colors: ReturnType<typeof tokens>;
    format: (value: number | null) => string;
    compact: (value: number) => string;
    stacked: boolean;
    title: string;
    dark: boolean;
  },
): EChartsCoreOption {
  const { colors, format, compact, stacked } = context;
  const horizontal =
    data.chartType === "bar_horizontal" || data.chartType === "pie";
  const line = data.chartType === "line" || data.chartType === "area";
  const many = data.series.length > 1;
  const text = { color: colors.muted, fontSize: 11 };
  const categoryAxis = {
    type: "category" as const,
    data: data.categories,
    axisLine: { lineStyle: { color: colors.grid } },
    axisTick: { show: false },
    axisLabel: { ...text, hideOverlap: true },
    ...(horizontal ? { inverse: true } : {}),
  };
  const valueAxis = {
    type: "value" as const,
    ...(data.chartType === "pie" ? { max: 100 } : {}),
    splitLine: { lineStyle: { color: colors.grid, width: 1, type: "solid" } },
    axisLabel: { ...text, formatter: compact },
  };
  const last = data.series.length - 1;
  return {
    color: colors.series,
    darkMode: context.dark,
    backgroundColor: "transparent",
    textStyle: { fontFamily: "inherit", color: colors.text },
    aria: { enabled: true, label: { description: context.title } },
    animationDuration: 300,
    grid: {
      left: 8,
      // Room for the value at a horizontal bar's end.
      right: horizontal && !many ? 56 : 16,
      top: many ? 32 : 12,
      bottom: 8,
      containLabel: true,
    },
    legend: many
      ? {
          top: 0,
          left: 0,
          icon: line ? "path://M0,4 L14,4" : "rect",
          itemWidth: 12,
          itemHeight: line ? 2 : 8,
          textStyle: { color: colors.text, fontSize: 11 },
          lineStyle: { width: 2 },
        }
      : { show: false },
    tooltip: {
      trigger: line ? "axis" : "item",
      ...(line
        ? { axisPointer: { type: "line", lineStyle: { color: colors.muted } } }
        : {}),
      backgroundColor: colors.surface,
      borderColor: colors.grid,
      textStyle: { color: colors.text, fontSize: 12 },
      // The value leads, the series follows; names are escaped.
      formatter: (raw: unknown) => {
        const items = (Array.isArray(raw) ? raw : [raw]) as Array<{
          name: string;
          seriesName: string;
          value: number | null;
          color: string;
        }>;
        const head = escape(items[0]?.name ?? "");
        const rows = items.map(
          (item) =>
            `<div style="display:flex;align-items:center;gap:6px"><span style="display:inline-block;width:12px;height:2px;background:${item.color}"></span><strong>${escape(format(item.value))}</strong>${many ? `<span style="opacity:.75">${escape(item.seriesName)}</span>` : ""}</div>`,
        );
        return `<div style="opacity:.75;margin-bottom:2px">${head}</div>${rows.join("")}`;
      },
    },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series: data.series.map((item, index) => {
      const radius = horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];
      if (line) {
        return {
          type: "line",
          name: item.name,
          data: item.values,
          connectNulls: false,
          ...(stacked && many ? { stack: "total" } : {}),
          lineStyle: { width: 2, cap: "round", join: "round" },
          symbol: "circle",
          symbolSize: 8,
          showSymbol: data.categories.length <= 24,
          itemStyle: { borderColor: colors.surface, borderWidth: 2 },
          ...(data.chartType === "area" ? { areaStyle: { opacity: 0.1 } } : {}),
          // A value at the end of each line, while lines stay few.
          endLabel: {
            show: data.series.length <= 4,
            color: colors.text,
            fontSize: 11,
            formatter: (params: { value: number | null }) =>
              params.value === null ? "" : compact(params.value),
          },
        };
      }
      return {
        type: "bar",
        name: item.name,
        data: item.values,
        barMaxWidth: 24,
        ...(stacked && many ? { stack: "total" } : {}),
        // The 2 px surface gap between touching marks; the data end rounds.
        itemStyle: {
          borderColor: colors.surface,
          borderWidth: 1,
          borderRadius: !stacked || !many || index === last ? radius : 0,
        },
        emphasis: { focus: "series" },
        // A value at each bar's end, for one series of few bars.
        label: {
          show: !many && data.categories.length <= 12,
          position: horizontal ? "right" : "top",
          color: colors.text,
          fontSize: 11,
          formatter: (params: { value: number | null }) =>
            params.value === null ? "" : compact(params.value),
        },
      };
    }),
  };
}
