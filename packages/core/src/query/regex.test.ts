import { describe, expect, it } from "vitest";
import { portableRegex, regexReplacement } from "./regex";

const rewrite = (source: string) =>
  portableRegex(source, "regex_match").pattern;

describe("portableRegex", () => {
  it("rewrites shorthands as ASCII classes, and the dot and the end exactly", () => {
    expect(rewrite("\\d+-\\w*\\s?")).toBe(
      "[0-9]+-[A-Za-z0-9_]*[ \\t\\n\\r\\f]?",
    );
    expect(rewrite("\\D\\W\\S")).toBe("[^0-9][^A-Za-z0-9_][^ \\t\\n\\r\\f]");
    expect(rewrite("^a.b$")).toBe("^a[^\\n]b(?!(?:[^\\n]|\\n))");
    expect(rewrite("[\\d_a-f-]")).toBe("[0-9_a-f\\-]");
    expect(rewrite("[]a^[]")).toBe("[\\]a\\^\\[]");
    expect(rewrite("\\.\\(\\$")).toBe("\\.\\(\\$");
    expect(rewrite("\\bcat\\b")).toContain("(?<![A-Za-z0-9_])");
  });

  it("counts groups, reads the case option, and tells an ambiguous pattern", () => {
    expect(portableRegex("(?i)(a)(?:b)(c)", "regex_match")).toEqual({
      pattern: "(a)(?:b)(c)",
      groups: 2,
      caseless: true,
      ambiguous: false,
    });
    expect(portableRegex("a|ab", "regex_match").ambiguous).toBe(true);
    expect(portableRegex("a+?", "regex_match").ambiguous).toBe(true);
    expect(portableRegex("a{2,3}(?=b)(?!c)", "regex_match").ambiguous).toBe(
      false,
    );
  });

  it("refuses what the engines would read differently, or not at all", () => {
    for (const source of [
      "",
      "(a",
      "a)",
      "*a",
      "a**",
      "a++",
      "a{2,1}",
      "a{256}",
      "a{x}",
      "(?<=a)b",
      "(?<n>a)",
      "(a)\\1",
      "\\p{L}",
      "\\B",
      "a]",
      "a}",
      "[a",
      "(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)",
    ]) {
      expect(() => portableRegex(source, "regex_match"), source).toThrow(
        "Invalid arguments",
      );
    }
  });
});

describe("regexReplacement", () => {
  it("reads groups, the whole match, and a dollar", () => {
    expect(regexReplacement("$2, $1 ($$) [$&] $x", 2, "regex_replace")).toEqual(
      [
        { group: 2 },
        { text: ", " },
        { group: 1 },
        { text: " ($) [" },
        { group: 0 },
        { text: "] $x" },
      ],
    );
    expect(() => regexReplacement("$3", 2, "regex_replace")).toThrow(
      "Invalid arguments",
    );
  });
});
