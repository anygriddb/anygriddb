import { describe, expect, it } from "vitest";
import { fillValues, parseClipboard, planPaste } from "./grid-clipboard";

const columns = [
  {
    name: "title",
    label: "Title",
    fieldType: "text",
    config: {},
    kind: "text",
    error: null,
  },
  {
    name: "qty",
    label: "Qty",
    fieldType: "number",
    config: {},
    kind: "number",
    error: null,
  },
  {
    name: "total",
    label: "Total",
    fieldType: "formula",
    config: {},
    kind: "number",
    error: null,
  },
] as never[];

describe("grid clipboard", () => {
  it("plans updates, inserts, and skips cells that do not fit", () => {
    const rows = [{ id: "r1" }, { id: "r2" }] as never[];
    const plan = planPaste({
      matrix: parseClipboard("a\t1\t9\nb\tnope\nc\t3"),
      rows,
      columns,
      startRow: 0,
      startColumn: 0,
      resolveUser: () => undefined,
    });
    // Pasted numbers are exact decimals (ADR 0023).
    expect(plan.updates).toEqual([
      { rowId: "r1", values: { title: "a", qty: "1" } },
      { rowId: "r2", values: { title: "b" } },
    ]);
    expect(plan.inserts).toEqual([{ title: "c", qty: "3" }]);
    expect(plan.skipped).toBe(2);
  });

  it("fills a single value across a range and extends number series", () => {
    const plan = planPaste({
      matrix: [["x"]],
      rows: [{ id: "r1" }, { id: "r2" }] as never[],
      columns,
      startRow: 0,
      startColumn: 0,
      range: { rows: 2, columns: 1 },
      resolveUser: () => undefined,
    });
    expect(plan.updates.map((update) => update.values.title)).toEqual([
      "x",
      "x",
    ]);
    expect(fillValues([1, 3], 3)).toEqual([5, 7, 9]);
    expect(fillValues(["0.1", "0.2"], 2)).toEqual(["0.3", "0.4"]);
    expect(fillValues(["a"], 2)).toEqual(["a", "a"]);
    expect(parseClipboard('"a\tb"\tc')).toEqual([["a\tb", "c"]]);
  });
});
