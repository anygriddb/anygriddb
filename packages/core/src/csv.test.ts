import { describe, expect, it } from "vitest";
import {
  DelimitedReader,
  parseCsv,
  parseDelimited,
  toCsv,
  toCsvRows,
} from "./csv";

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

describe("DelimitedReader", () => {
  const tricky =
    '\uFEFFname;note\r\n"Dupont; Jean";"said ""hi""\r\nthen left"\n' +
    '"";x"y\n""""quoted;last';

  function readAll(pieces: readonly string[], maxCell?: number): string[][] {
    const reader = new DelimitedReader({ delimiter: ";", maxCell });
    return [...pieces.flatMap((piece) => reader.push(piece)), ...reader.end()];
  }

  it("reads the same records wherever the text is cut", () => {
    const whole = readAll([tricky]);
    expect(whole).toEqual([
      ["name", "note"],
      ["Dupont; Jean", 'said "hi"\r\nthen left'],
      ["", 'x"y'],
      ['"quoted', "last"],
    ]);
    expect(whole).toEqual(
      parseDelimited(tricky, { delimiter: ";", ragged: true }),
    );
    for (let cut = 0; cut <= tricky.length; cut += 1) {
      expect(readAll([tricky.slice(0, cut), tricky.slice(cut)])).toEqual(whole);
    }
    // One code unit at a time.
    expect(
      readAll(
        Array.from({ length: tricky.length }, (_, i) => tricky.charAt(i)),
      ),
    ).toEqual(whole);
  });

  it("keeps the start of a long cell, and refuses an open quote or too many cells", () => {
    expect(readAll(["a;bcdef\n", "ghij;k"], 3)).toEqual([
      ["a", "bcd"],
      ["ghi", "k"],
    ]);
    const open = new DelimitedReader({ delimiter: "," });
    open.push('a,"never closed\n');
    expect(() => open.end()).toThrow(/Invalid csv/);
    const wide = new DelimitedReader({ delimiter: ",", maxCells: 2 });
    expect(() => wide.push("a,b,c\n")).toThrow(/Invalid csv/);
  });
});
