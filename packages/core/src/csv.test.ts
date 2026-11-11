import { describe, expect, it } from "vitest";
import { parseCsv, parseDelimited, toCsv, toCsvRows } from "./csv";

describe("csv", () => {
  it("round-trips quotes and prefixes formula-like cells", () => {
    const parsed = parseCsv('title,amount\n"a,b",2\n');
    expect(parsed).toEqual([
      ["title", "amount"],
      ["a,b", "2"],
    ]);
    expect(toCsv(["title"], [{ title: "=cmd" }])).toBe("title\n'=cmd");
    expect(toCsv(["title"], [{ title: "\t=cmd" }])).toBe("title\n'\t=cmd");
    expect(toCsv(["title"], [{ title: "\r=cmd" }])).toBe('title\n"\'\r=cmd"');
    expect(() => parseCsv("title\n")).toThrow(/Invalid csv/);
  });

  it("writes a header alone, and records without their header", () => {
    expect(toCsv(["title", "n"], [])).toBe("title,n");
    expect(
      toCsvRows(
        ["title", "n"],
        [
          { title: "a,b", n: 1 },
          { title: "c", n: 2 },
        ],
      ),
    ).toBe('"a,b",1\nc,2');
    expect(toCsvRows(["title"], [])).toBe("");
    expect(() => toCsvRows([], [])).toThrow(/Invalid csv/);
  });
});

describe("parseDelimited ragged", () => {
  it("accepts short records and empty trailing cells", () => {
    expect(parseDelimited("a,b,c\n1\n2,3,4,\n", { ragged: true })).toEqual([
      ["a", "b", "c"],
      ["1"],
      ["2", "3", "4", ""],
    ]);
  });

  it("still refuses a record with extra values", () => {
    expect(() => parseDelimited("a,b\n1,2,3\n", { ragged: true })).toThrow(
      "Invalid csv",
    );
    expect(() => parseDelimited("a,b\n1\n")).toThrow("Invalid csv");
  });
});
