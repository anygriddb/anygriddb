import { describe, expect, it } from "vitest";
import {
  conversionChanges,
  convertCell,
  restoredCell,
} from "./cell-conversion";
import { assertCellValue, readCellValue, type CellColumn } from "./cell-values";
import type { ColumnConfig } from "./field-config";
import type { FieldType } from "./field-types";

const OPTIONS = ["abc", "12", "Dupont, Marie", "a", "b", "true"].map(
  (name) => ({ name, color: "gray" }),
);
const config = { options: OPTIONS } as unknown as ColumnConfig;
const TYPES: FieldType[] = [
  "text",
  "long_text",
  "email",
  "url",
  "phone",
  "color",
  "place",
  "json",
  "single_select",
  "multi_select",
  "number",
  "rating",
  "duration",
  "boolean",
  "date",
  "datetime",
];
const field = (fieldType: FieldType): CellColumn => ({ fieldType, config });

const TEXTS = [
  "",
  "   ",
  "true",
  "on",
  "✓",
  "oui",
  "off",
  "non",
  "maybe",
  "abc",
  "ABC",
  "12",
  "12.50",
  "1,5",
  "1,234",
  "1 234",
  "€12",
  "-5",
  "7.5",
  "4",
  "★★★",
  "1:30",
  "1d 1:01",
  "1e400",
  "9007199254740993",
  "2024-02-29",
  "29/02/2024",
  "03/04/2024",
  "2024/02/29",
  "29 février 2024",
  "2024-02-29T13:45:30Z",
  "2024-02-29T13:45:30.123456+01:00",
  "2024-02-29 13:45",
  "2024-02-29 réunion annulée",
  "2024-02-29T25:00:00",
  "2024-02-30",
  "a@example.org",
  " a@example.org ",
  " a@example.org　",
  "a..b@example.org",
  ".a@example.org",
  "a b@example.org",
  "https://example.org",
  "HTTP://EXAMPLE.ORG/x y",
  "https:example.org",
  "https://user:pw@example.org",
  "javascript:alert(1)",
  "http://[::1]/",
  "http://[2001:db8::1]:8080/x",
  "http://1.2.3/",
  "http://127.1/",
  "http://0x7f.1/",
  "http://999999999999/",
  "http://256.1.1.1/",
  "http://a.1/",
  "http://127.0.0.1:8080/x",
  "https://example.org:70000/",
  "https://müller.example/",
  "https://例え.テスト/",
  "https://пример.рф/",
  "http://a.١/",
  "http://exa mple.org",
  "+33 1 23 45 67 89",
  "(12) 3",
  "#abc",
  "#1F3FAE",
  " #abc",
  "48.8566, 2.3522",
  "48,8566; 2,3522",
  "48.8566 2.3522",
  "91,0",
  '{"a":1}',
  '{ "a" : 1.50 }',
  "[1,2]",
  "[",
  '"text"',
  "a, b",
  "b, a, b",
  "a; b\nb",
  "a, z",
  "Dupont, Marie",
  "😀".repeat(3000),
  "x".repeat(4000),
  "x".repeat(5000),
  "y".repeat(20_000),
  "y".repeat(25_000),
];

describe("a value converted", () => {
  it("keeps every value the new field's write check takes, as it is", () => {
    const emptied: string[] = [];
    for (const to of TYPES) {
      const column = field(to);
      for (const text of TEXTS) {
        let takes = true;
        try {
          assertCellValue(column, text);
        } catch {
          takes = false;
        }
        if (takes && convertCell("text", column, text) === undefined) {
          emptied.push(`${to}: ${text.slice(0, 40)}`);
        }
      }
    }
    expect(emptied).toEqual([]);
  });

  it("keeps every value a cell reads, in a known zone", () => {
    const emptied: string[] = [];
    for (const to of TYPES) {
      const column = field(to);
      for (const text of TEXTS) {
        const reading = readCellValue(column, text, {
          timeZone: "Europe/Paris",
        });
        if (!("value" in reading)) continue;
        const kept = convertCell("text", column, text, "Europe/Paris");
        // The one reading a conversion declines: a float rounding what
        // was written, which would then read as something else.
        const rounded =
          (to === "duration" || to === "rating") && text === "9007199254740993";
        if (kept === undefined && !rounded) {
          emptied.push(`${to}: ${text.slice(0, 40)}`);
        }
      }
    }
    expect(emptied).toEqual([]);
  });

  it("keeps nothing the new field would refuse, for every pair", () => {
    const stored: Record<string, ReadonlyArray<string | boolean | string[]>> = {
      number: ["0", "1", "4", "7.5", "-5", "9007199254740993", "12.5"],
      boolean: [true, false],
      date: ["2024-02-29", "1999-12-31"],
      datetime: ["2024-02-29T13:45:30.123456Z", "2024-03-01T00:30:00Z"],
      multi_select: [[], ["a"], ["a", "b"], ["Dupont, Marie"], ["abc", "12"]],
      json: ['{"a": 1}', "[1, 2]"],
    };
    const refused: string[] = [];
    for (const from of TYPES) {
      const samples =
        stored[from === "rating" || from === "duration" ? "number" : from] ??
        TEXTS;
      for (const to of TYPES) {
        if (from === to) continue;
        const column = field(to);
        for (const sample of samples) {
          const kept = convertCell(from, column, sample, "Europe/Paris");
          if (kept === undefined || kept === null) continue;
          try {
            assertCellValue(column, kept);
          } catch {
            refused.push(`${from} -> ${to}: ${String(kept).slice(0, 40)}`);
          }
        }
      }
    }
    expect(refused).toEqual([]);
  });

  it("takes the addresses a link cell takes", () => {
    for (const url of [
      "http://[::1]/",
      "http://1.2.3/",
      "https://пример.рф/",
      "https:example.org",
    ]) {
      expect(convertCell("text", field("url"), url)).toBe(url);
    }
    expect(
      convertCell("text", field("url"), "javascript:alert(1)"),
    ).toBeUndefined();
  });

  it("reads what a checkbox reads, and a number by whether it is zero", () => {
    const box = field("boolean");
    for (const word of ["true", "on", "✓", "oui"]) {
      expect(convertCell("text", box, word)).toBe(true);
    }
    for (const word of ["off", "non"]) {
      expect(convertCell("text", box, word)).toBe(false);
    }
    for (const word of ["maybe", "abc", "2024-02-29"]) {
      expect(convertCell("text", box, word)).toBeUndefined();
    }
    expect(convertCell("text", box, "  ")).toBeNull();
    expect(convertCell("number", box, "7")).toBe(true);
    expect(convertCell("number", box, "0")).toBe(false);
  });

  it("keeps an option whole, splits a text, and refuses one outside", () => {
    const list = field("multi_select");
    expect(convertCell("single_select", list, "Dupont, Marie")).toEqual([
      "Dupont, Marie",
    ]);
    expect(convertCell("text", list, "b, a, b")).toEqual(["b", "a"]);
    expect(convertCell("text", list, "a, z")).toBeUndefined();
    expect(convertCell("multi_select", field("single_select"), ["a"])).toBe(
      "a",
    );
    expect(
      convertCell("multi_select", field("single_select"), ["a", "b"]),
    ).toBeUndefined();
  });

  it("reads a time with no zone only where a zone is given", () => {
    const when = field("datetime");
    expect(convertCell("text", when, "2024-02-29 13:45")).toBeUndefined();
    expect(convertCell("text", when, "2024-02-29 13:45", "UTC")).toBe(
      "2024-02-29T13:45:00Z",
    );
    expect(convertCell("text", when, "2024-02-29T13:45:00+01:00")).toBe(
      "2024-02-29T13:45:00+01:00",
    );
    expect(convertCell("date", when, "2024-02-29", "America/New_York")).toBe(
      "2024-02-29T05:00:00Z",
    );
  });

  it("keeps a duration or a rating only if it reads back the same", () => {
    expect(
      convertCell("number", field("duration"), "9007199254740993"),
    ).toBeUndefined();
    expect(convertCell("number", field("duration"), "90.5")).toBe(90.5);
    expect(convertCell("text", field("duration"), "1:30")).toBe(5400);
    expect(convertCell("number", field("rating"), "7.5")).toBeUndefined();
    expect(convertCell("text", field("rating"), "★★★")).toBe(3);
  });

  it("says what it writes differently", () => {
    expect(conversionChanges("12.5", "12.5", "text")).toBe(false);
    expect(conversionChanges("12.50", "12.50", "number")).toBe(true);
    expect(conversionChanges("b, a, b", ["b", "a"], "multi_select")).toBe(true);
    expect(conversionChanges("abc", undefined, "number")).toBe(true);
    expect(conversionChanges("  ", null, "number")).toBe(false);
  });
});

describe("a value brought back from the trash", () => {
  it("comes back as the field holds it, and what no longer fits does not", () => {
    expect(restoredCell(field("url"), "http://[::1]/")).toBe("http://[::1]/");
    expect(restoredCell(field("number"), "12")).toBe("12");
    expect(restoredCell(field("number"), "abc")).toBeUndefined();
    expect(restoredCell(field("boolean"), "oui")).toBe(true);
    expect(restoredCell(field("boolean"), true)).toBe(true);
    expect(restoredCell(field("text"), ["A", "B"])).toBe("A, B");
    expect(restoredCell(field("multi_select"), "gone")).toEqual(["gone"]);
    expect(restoredCell(field("attachment"), "x")).toBeUndefined();
  });

  it("does not guess the day of an instant", () => {
    expect(
      restoredCell(field("date"), "2024-03-01T00:30:00+00:00"),
    ).toBeUndefined();
    expect(restoredCell(field("date"), "2024-03-01")).toBe("2024-03-01");
    expect(restoredCell(field("datetime"), "2024-02-29")).toBeUndefined();
    expect(restoredCell(field("datetime"), "2024-03-01T00:30:00+00:00")).toBe(
      "2024-03-01T00:30:00+00:00",
    );
  });
});
