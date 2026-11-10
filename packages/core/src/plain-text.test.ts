import { describe, expect, it } from "vitest";
import { mysqlEnumValues } from "./source-types";
import {
  cutAt,
  cutAtSpace,
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
