# 0035 — Dashboard charts: aggregates by the source, drawn with ECharts

- Status: Accepted
- Date: 2026-11-08

## Context

Dashboard charts counted rows per group, drawn as hand-made SVG bars,
lines, or pies. Their "value" setting (a sum, a mean) was saved and then
ignored. ADR 0020 named Apache ECharts as the replacement once dashboards
grow, and phase 7 has the source compute their aggregates.

## Decision

- **The engine the rows live in computes one aggregate per group**: a
  count, sum, mean, extreme, or share of up to two fields, the second
  making series. The read engine's new `groupAggregates`, written per
  dialect, runs under the reader's field and row rules like any read. The
  median, which reads each group's rows again, is not offered per group.
  The conformance suite requires the same groups and values on the four
  engines.
- **The API shapes the chart.**
  - Categories follow a select's options, then natural order; at most 40
    are drawn and the rest are counted.
  - At most eight series are drawn. Past that, the smallest fold into
    "others" when the measure adds up; otherwise they are left out and
    counted.
  - A group whose values are all empty has no value, not zero.
- **ECharts 6 draws the chart** (Apache-2.0), tree-shaken to bars, lines,
  and the SVG renderer, and loaded with the dashboards only.
  - Colours come from eight series tokens in the theme, in a fixed order,
    each mode its own steps. They are validated for colour vision
    deficiencies against the card surface.
  - Bars are at most 24 px, with a rounded data end, and stacked segments
    are separated by a 2 px gap in the surface colour.
  - Lines are 2 px, with 8 px markers and an end value while they are
    few.
  - Grids are hairlines, and there is a single value axis.
  - Sums and counts stack; means and extremes stand side by side.
- **Forms.** The forms are columns, horizontal bars, a line, an area, and
  each group's share of the total. Shares are drawn as sorted bars,
  which compare better than slices. Saved pie charts read that way.
- **Every value is reachable without colour or hover.**
  - A legend appears from two series.
  - Values are labelled sparingly.
  - Tooltips put the value first, with names escaped.
  - A table view of the same values replaces the chart on demand.
  - Keys read in the reader's language: yes or no for a checkbox, and
    dates in their locale.

## Consequences

- Dashboards load ECharts (550 kB, 185 kB compressed) in their own
  chunk; other pages do not.
- A chart reads one aggregate per group from the client's database,
  never its rows.

## Rejected

- **Keeping hand-drawn SVG.** Axes, stacking, tooltips, and accessible
  descriptions would each be ours to maintain.
- **Pie and donut charts.** Close shares cannot be told apart by angle;
  bars of shares say the same, readably.
