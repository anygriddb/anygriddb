import { describe, expect, it } from "vitest";
import { mysqlEnumValues } from "./source-types";
import {
  cutAt,
  cutAtSpace,
  holdsUnwritableText,
  trimEndRun,
  trimRuns,
  withoutGroups,
  withoutOuterGroup,
} from "./plain-text";

const TYPES = [
  "numeric(12,2)",
  "timestamp(3) with time zone",
  "decimal(10, 2) unsigned",
  "a(b(c)d)e",
  "a(b)c(d",
  "a)b(c",
  "varchar",
  "",
  "(",
  "()",
];

describe("plain-text edits", () => {
  it("say what the patterns they replace said", () => {
    for (const text of TYPES) {
      expect(withoutGroups(text), text).toBe(text.replace(/\([^)]*\)/g, ""));
      expect(withoutOuterGroup(text), text).toBe(text.replace(/\(.*\)/, ""));
      expect(cutAt(text, "("), text).toBe(text.replace(/\(.*$/, ""));
      expect(cutAtSpace(text), text).toBe(text.replace(/\s.*$/, ""));
    }
    for (const text of ["12.500", "0", "000", "1.0", "", "5"]) {
      expect(trimEndRun(text, "0"), text).toBe(text.replace(/0+$/, ""));
    }
    for (const text of ["__a_b__", "_", "a", "", "a__"]) {
      expect(trimRuns(text, "_"), text).toBe(text.replace(/^_+|_+$/g, ""));
    }
  });

  it("stay linear on texts built to make a pattern backtrack", () => {
    const hostile = [
      "(".repeat(100_000),
      `${"0".repeat(100_000)}1`,
      `${" ".repeat(100_000)}x`,
      `enum('${"\\'".repeat(50_000)}`,
    ];
    const started = performance.now();
    for (const text of hostile) {
      withoutGroups(text);
      withoutOuterGroup(text);
      cutAt(text, "(");
      cutAtSpace(text);
      trimEndRun(text, "0");
      trimRuns(text, " ");
      mysqlEnumValues(text);
    }
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("mysqlEnumValues", () => {
  it("reads escaped quotes and backslashes as MySQL prints them", () => {
    expect(mysqlEnumValues(String.raw`enum('it''s','a\'b','c\\d','')`)).toEqual(
      ["it's", "a'b", String.raw`c\d`, ""],
    );
  });

  it("stops at a label left open, and reads no enum from another type", () => {
    expect(mysqlEnumValues("enum('a','b)")).toEqual(["a"]);
    expect(mysqlEnumValues("varchar(20)")).toBeUndefined();
  });
});

describe("holdsUnwritableText", () => {
  it("takes every text a person can write", () => {
    for (const value of [
      "plain",
      "é € 日本語",
      "a 😀 b",
      "'quotes\"; --",
      "line\nbreak\ttab",
      "",
      42,
      null,
      undefined,
      true,
      { a: ["b", { c: "😀" }] },
    ]) {
      expect(holdsUnwritableText(value)).toBe(false);
    }
  });

  it("finds a NUL or half a pair, wherever it is", () => {
    for (const text of ["a\u0000b", "a\ud800b", "\udc00", "😀\ud83d"]) {
      expect(holdsUnwritableText(text)).toBe(true);
      expect(holdsUnwritableText([1, [text]])).toBe(true);
      expect(holdsUnwritableText({ a: { b: [{ c: text }] } })).toBe(true);
      expect(holdsUnwritableText({ [text]: 1 })).toBe(true);
      expect(
        holdsUnwritableText(Object.assign(Object.create(null), { a: text })),
      ).toBe(true);
    }
  });

  it("reads the bare object a query string is parsed into", () => {
    const bare = Object.create(Object.create(null) as object) as object;
    const query = Object.assign(bare, { filter: "a\u0000b" });
    expect(holdsUnwritableText(query)).toBe(true);
  });

  it("leaves what the caller read and sends back to compare", () => {
    const update = { values: { a: "new" }, expected: { a: "held\u0000" } };
    expect(holdsUnwritableText(update, new Set(["expected"]))).toBe(false);
    expect(holdsUnwritableText(update)).toBe(true);
    expect(
      holdsUnwritableText(
        { values: { a: "\u0000" }, expected: {} },
        new Set(["expected"]),
      ),
    ).toBe(true);
  });

  it("walks a body nested deeper than a call stack", () => {
    let deep: unknown = "a\u0000";
    for (let level = 0; level < 200_000; level += 1) deep = [deep];
    expect(holdsUnwritableText(deep)).toBe(true);
  });

  it("does not read into a buffer or a stream", () => {
    expect(holdsUnwritableText(Buffer.from([0, 0, 0]))).toBe(false);
    expect(holdsUnwritableText(new Date())).toBe(false);
  });
});
