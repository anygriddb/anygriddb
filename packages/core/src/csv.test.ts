import { describe, expect, it } from "vitest";
import { parseCsv, parseDelimited, toCsv } from "./csv";

describe("csv", () => {
  it("round-trips quotes and prefixes formula-like cells", () => {
    const parsed = parseCsv('title,amount\n"a,b",2\n');
    expect(parsed).toEqual([
      ["title", "amount"],
      ["a,b", "2"],
    ]);
    expect(toCsv(["title"], [{ title: "=cmd" }])).toBe("title\n'=cmd");
    expect(() => parseCsv("title\n")).toThrow(/Invalid csv/);
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
