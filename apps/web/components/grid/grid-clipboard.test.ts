import { describe, expect, it } from "vitest";
import {
  copiedCells,
  fillValues,
  parseClipboard,
  planPaste,
  toTsv,
} from "./grid-clipboard";

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

  const copied = (title: string) =>
    toTsv(
      [{ id: "r1", title }] as never[],
      columns.slice(0, 1),
      "en",
      new Map(),
    );

  it("prefixes a formula so a spreadsheet does not run it", () => {
    expect(copied('=HYPERLINK("http://example.test")')).toBe(
      '\'=HYPERLINK("http://example.test")',
    );
    // In a block, the same cell is quoted too, and stays guarded.
    expect(
      toTsv(
        [
          { id: "r1", title: '=HYPERLINK("http://example.test")' },
          { id: "r2", title: "b" },
        ] as never[],
        columns.slice(0, 1),
        "en",
        new Map(),
      ),
    ).toBe('"\'=HYPERLINK(""http://example.test"")"\nb');
    expect(copied("-1+cmd|' /C calc'!A0")).toBe("'-1+cmd|' /C calc'!A0");
    expect(copied("@SUM(1)")).toBe("'@SUM(1)");
  });

  it("leaves numbers as numbers, signed or not", () => {
    expect(copied("-5")).toBe("-5");
    expect(copied("+33 6 12 34 56 78")).toBe("+33 6 12 34 56 78");
    expect(copied("-1,234.50")).toBe("-1,234.50");
    expect(copied("-")).toBe("'-");
  });

  it("pastes back what it copied, without the guard", () => {
    for (const value of [
      "=1+1",
      "-1+cmd",
      "@handle",
      "+x",
      "'quoted",
      "'=kept",
      "-5",
    ]) {
      expect(parseClipboard(copied(value))).toEqual([[value]]);
    }
    expect(parseClipboard(`${copied("=a")}\t${copied("b")}`)).toEqual([
      ["=a", "b"],
    ]);
  });

  it("leaves a lone cell's quotes alone, and pastes it back as it was", () => {
    for (const value of ['a"b', '"quoted"', '5" screen', '{"a": [1, 2]}']) {
      expect(copied(value)).toBe(value);
      expect(parseClipboard(copied(value))).toEqual([[value]]);
    }
  });

  it("still protects a lone cell that holds a tab or a line", () => {
    expect(copied("a\tb")).toBe('"a\tb"');
    expect(parseClipboard(copied('q"uo\nte'))).toEqual([['q"uo\nte']]);
  });

  it("keeps a block's quoting, cell by cell", () => {
    const text = toTsv(
      [
        { id: "r1", title: 'a"b' },
        { id: "r2", title: "c" },
      ] as never[],
      columns.slice(0, 1),
      "en",
      new Map(),
    );
    expect(text).toBe('"a""b"\nc');
    expect(parseClipboard(text)).toEqual([['a"b'], ["c"]]);
  });

  it("leaves the quotes of a text that came from elsewhere", () => {
    expect(parseClipboard('"quoted"')).toEqual([['"quoted"']]);
  });
});

describe("what a copy keeps of its cells", () => {
  const rounded = {
    name: "price",
    label: "Price",
    fieldType: "number",
    config: { number: { precision: 2 } },
    kind: "number",
    error: null,
  };
  const duration = {
    name: "spent",
    label: "Spent",
    fieldType: "duration",
    config: {},
    kind: "number",
    error: null,
  };
  const named = {
    name: "title",
    label: "Title",
    fieldType: "text",
    config: {},
    kind: "text",
    error: null,
  };
  const target = [{ id: "t1" }] as never[];
  const paste = (
    text: string,
    field: unknown,
    exact: ReturnType<typeof copiedCells>["cells"] | null,
  ) =>
    planPaste({
      matrix: parseClipboard(text),
      exact,
      rows: target,
      columns: [field] as never[],
      startRow: 0,
      startColumn: 0,
      resolveUser: () => undefined,
    }).updates[0]?.values;

  it("shows the rounded text, and keeps the exact value", () => {
    const { text, cells } = copiedCells(
      [{ id: "r1", price: "1.23456789012" }] as never[],
      [rounded] as never[],
      "en",
      new Map(),
    );
    expect(text).toBe("1.23");
    expect(paste(text, rounded, cells)).toEqual({ price: "1.23456789012" });
  });

  it("keeps a tiny number and a duration to the second", () => {
    for (const [field, value] of [
      [rounded, "0.000000000001"],
      [duration, 3661],
      [duration, 59],
    ] as const) {
      const { text, cells } = copiedCells(
        [{ id: "r1", [field.name]: value }] as never[],
        [field] as never[],
        "en",
        new Map(),
      );
      expect(paste(text, field, cells)).toEqual({ [field.name]: value });
    }
  });

  it("reads the text when the field it lands in is of another type", () => {
    const { text, cells } = copiedCells(
      [{ id: "r1", price: "1.23456789012" }] as never[],
      [rounded] as never[],
      "en",
      new Map(),
    );
    expect(paste(text, named, cells)).toEqual({ title: "1.23" });
  });

  it("reads the text when nothing was kept for it", () => {
    expect(paste("1.23", rounded, null)).toEqual({ price: "1.23" });
  });

  it("keeps a copied instant's decimals where the column keeps them", () => {
    const seven = "2024-03-31T02:30:00.1234567+00:00";
    const instant = {
      name: "at",
      label: "At",
      fieldType: "datetime",
      config: {},
      kind: "datetime",
      error: null,
    };
    const copied = [[{ fieldType: "datetime", value: seven }]] as never;
    expect(
      paste("31/03/2024", { ...instant, instantDigits: 7 }, copied),
    ).toEqual({ at: seven });
    expect(paste(seven, instant, copied)).toBeUndefined();
  });

  it("never takes a list or an object as an exact value", () => {
    const files = {
      name: "files",
      label: "Files",
      fieldType: "attachment",
      config: {},
      kind: "text",
      error: null,
    };
    const plan = planPaste({
      matrix: [["a.pdf"]],
      exact: [[{ fieldType: "attachment", value: [{ key: "k" }] }]],
      rows: target,
      columns: [files] as never[],
      startRow: 0,
      startColumn: 0,
      resolveUser: () => undefined,
    });
    // The text is read, and a file's name is no file: nothing is written.
    expect(plan.updates).toEqual([]);
    expect(plan.skipped).toBe(1);
  });
});

describe("what a paste could not place", () => {
  const plan = (input: { text: string; rows?: number; canInsert?: boolean }) =>
    planPaste({
      matrix: parseClipboard(input.text),
      rows: Array.from({ length: input.rows ?? 1 }, (_, index) => ({
        id: `r${index}`,
      })) as never[],
      columns: columns.slice(0, 2),
      startRow: 0,
      startColumn: 0,
      resolveUser: () => undefined,
      ...(input.canInsert === undefined ? {} : { canInsert: input.canInsert }),
    });

  it("says nothing of a block that fits", () => {
    expect(plan({ text: "a\t1\nb\t2", rows: 2 }).unplaced).toBe(0);
  });

  it("counts what runs past the last field", () => {
    const wide = plan({ text: "a\t1\textra\tmore" });
    expect(wide.unplaced).toBe(2);
    expect(wide.updates[0]?.values).toEqual({ title: "a", qty: "1" });
  });

  it("does not count an empty cell past the last field", () => {
    expect(plan({ text: "a\t1\t\t" }).unplaced).toBe(0);
  });

  it("counts the rows it may not add, value by value", () => {
    const long = plan({ text: "a\t1\nb\t2\nc", canInsert: false });
    expect(long.inserts).toEqual([]);
    expect(long.unplaced).toBe(3);
  });

  it("adds the rows it may add", () => {
    const long = plan({ text: "a\nb", canInsert: true });
    expect(long.inserts).toEqual([{ title: "b" }]);
    expect(long.unplaced).toBe(0);
  });
});

describe("a paste read in the reader's language", () => {
  const rows = [{ id: "r1" }] as never[];
  const paste = (text: string, decimalMark?: "." | ",") =>
    planPaste({
      matrix: [[text]],
      rows,
      columns,
      startRow: 0,
      startColumn: 1,
      resolveUser: () => undefined,
      ...(decimalMark ? { reading: { decimalMark, timeZone: "UTC" } } : {}),
    });

  it("gives 1,234 the value its language writes", () => {
    expect(paste("1,234", ".").updates[0]?.values.qty).toBe("1234");
    expect(paste("1,234", ",").updates[0]?.values.qty).toBe("1.234");
  });

  it("counts it as skipped when nothing says what its comma is", () => {
    expect(paste("1,234")).toMatchObject({ updates: [], skipped: 1 });
  });
});

describe("a paste that reads two ways", () => {
  const rows = [{ id: "r1" }] as never[];
  const fields = [
    {
      name: "qty",
      label: "Qty",
      fieldType: "number",
      config: {},
      kind: "number",
      error: null,
    },
    {
      name: "day",
      label: "Day",
      fieldType: "date",
      config: {},
      kind: "date",
      error: null,
    },
    {
      name: "us",
      label: "Us",
      fieldType: "date",
      config: { date: { format: "us" } },
      kind: "date",
      error: null,
    },
  ] as never[];
  const paste = (
    text: string,
    startColumn: number,
    reading: Parameters<typeof planPaste>[0]["reading"],
  ) =>
    planPaste({
      matrix: [[text]],
      rows,
      columns: fields,
      startRow: 0,
      startColumn,
      resolveUser: () => undefined,
      reading,
    });
  const french = {
    decimalMark: ",",
    dayOrder: "day-first",
    timeZone: "UTC",
  } as const;
  const english = { decimalMark: ".", timeZone: "UTC" } as const;

  it("refuses 1.234 in French and says so, and keeps it in English", () => {
    expect(paste("1.234", 0, french)).toMatchObject({
      updates: [],
      skipped: 1,
      ambiguousPoints: 1,
    });
    expect(paste("1.234", 0, english).updates[0]?.values.qty).toBe("1.234");
    expect(paste("1.5", 0, french).updates[0]?.values.qty).toBe("1.5");
  });

  it("settles a date in French, and refuses it in English", () => {
    expect(paste("03/04/2026", 1, french).updates[0]?.values.day).toBe(
      "2026-04-03",
    );
    expect(paste("03/04/2026", 1, english)).toMatchObject({
      updates: [],
      skipped: 1,
      ambiguousDates: 1,
    });
    expect(paste("13/04/2026", 1, english).updates[0]?.values.day).toBe(
      "2026-04-13",
    );
    expect(paste("03/04/2026", 2, english).updates[0]?.values.us).toBe(
      "2026-03-04",
    );
  });
});
