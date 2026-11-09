import { describe, expect, it } from "vitest";
import {
  checkFormula,
  formatFormula,
  formulaExprSchema,
  formulaReferences,
  formulaTokens,
  parseFormula,
} from "./formula";

const refs = [
  { name: "price", label: "Prix TTC" },
  { name: "qty", label: "Quantité" },
  { name: "done", label: "done" },
];

describe("parseFormula", () => {
  it("parses references, precedence, functions, and aliases", () => {
    expect(parseFormula("{Prix TTC} * {Quantité} + 1", refs)).toEqual({
      op: "add",
      left: {
        op: "mul",
        left: { op: "col", name: "price" },
        right: { op: "col", name: "qty" },
      },
      right: { op: "num", value: 1 },
    });
    expect(parseFormula('IF(done, "ok", "")', refs)).toEqual({
      op: "if",
      cond: { op: "col", name: "done" },
      then: { op: "str", value: "ok" },
      else: { op: "str", value: "" },
    });
    expect(parseFormula("concatenate({qty} & 'x')", refs)).toMatchObject({
      op: "call",
      fn: "concat",
    });
    expect(parseFormula("-{qty} >= 2", refs)).toMatchObject({
      op: "gte",
      left: { op: "neg" },
    });
    expect(parseFormula("today()", refs)).toEqual({
      op: "call",
      fn: "today",
      args: [],
    });
    // TRUE() is a function; a bare TRUE stays a literal.
    expect(parseFormula("TRUE()", refs)).toEqual({
      op: "call",
      fn: "true",
      args: [],
    });
    expect(parseFormula("false", refs)).toEqual({ op: "bool", value: false });
    expect(parseFormula("SUBSTR({qty}, 2)", refs)).toMatchObject({
      fn: "mid",
      args: [{ op: "col" }, { op: "num", value: 2 }],
    });
    expect(parseFormula("isNotBlank({qty})", refs)).toMatchObject({
      fn: "is_not_blank",
    });
    expect(parseFormula("TextBefore({qty}, '-')", refs)).toMatchObject({
      fn: "text_before",
    });
    expect(parseFormula("SPLIT({qty}, ',')", refs)).toMatchObject({
      fn: "text_split",
    });
    expect(
      parseFormula("ArraySlice(SPLIT({qty}, ','), 2)", refs),
    ).toMatchObject({ fn: "array_slice" });
    expect(parseFormula("to_now({qty}, 'hours')", refs)).toMatchObject({
      fn: "tonow",
    });
    // A backslash before a letter stays: patterns read as written.
    expect(
      parseFormula('REGEX_MATCH({qty}, "\\d+\\.\\\\")', refs),
    ).toMatchObject({
      fn: "regex_match",
      args: [{ op: "col" }, { op: "str", value: "\\d+\\.\\" }],
    });
    const quoted = parseFormula('"a\\"b\\\\c\\nd"', refs);
    expect(quoted).toEqual({ op: "str", value: 'a"b\\c\nd' });
    expect(parseFormula(formatFormula(quoted, refs), refs)).toEqual(quoted);
  });

  it("rejects unknown fields, functions, arity, and dangling input", () => {
    expect(() => parseFormula("{Missing} + 1", refs)).toThrow(/Unknown field/);
    expect(() => parseFormula("EVAL(1)", refs)).toThrow(/Unknown function/);
    expect(() => parseFormula("ROUND()", refs)).toThrow(/Invalid arguments/);
    expect(() => parseFormula("1 +", refs)).toThrow();
    expect(() => parseFormula("(1", refs)).toThrow(/parenthesis/);
    expect(() => parseFormula("'open", refs)).toThrow(/Unterminated/);
    expect(() => parseFormula("", refs)).toThrow(/Invalid formula/);
  });
});

describe("formatFormula", () => {
  it("round-trips through labels and keeps grouping", () => {
    const source = "({Prix TTC} + 1) * 2";
    const expr = parseFormula(source, refs);
    expect(formatFormula(expr, refs)).toBe("({Prix TTC} + 1) * 2");
    expect(parseFormula(formatFormula(expr, refs), refs)).toEqual(expr);
    expect(formulaReferences(expr)).toEqual(["price"]);
  });
});

describe("formulaExprSchema", () => {
  it("accepts stored ASTs and rejects a wrong arity", () => {
    expect(
      formulaExprSchema.safeParse({
        op: "call",
        fn: "abs",
        args: [{ op: "num", value: 1 }],
      }).success,
    ).toBe(true);
    expect(
      formulaExprSchema.safeParse({ op: "call", fn: "abs", args: [] }).success,
    ).toBe(false);
    expect(
      formulaExprSchema.safeParse({ op: "col", name: "Bad Name" }).success,
    ).toBe(false);
  });
});

describe("formula editing", () => {
  const refs = [{ name: "prix", label: "Prix" }];

  it("tokenizes with positions, and marks what it cannot read", () => {
    expect(formulaTokens('round({Prix} * 2, 1) & "€"')).toEqual([
      { kind: "function", from: 0, to: 5 },
      { kind: "punctuation", from: 5, to: 6 },
      { kind: "field", from: 6, to: 12 },
      { kind: "operator", from: 13, to: 14 },
      { kind: "number", from: 15, to: 16 },
      { kind: "punctuation", from: 16, to: 17 },
      { kind: "number", from: 18, to: 19 },
      { kind: "punctuation", from: 19, to: 20 },
      { kind: "operator", from: 21, to: 22 },
      { kind: "string", from: 23, to: 26 },
    ]);
    expect(formulaTokens('1 + "open').at(-1)).toEqual({
      kind: "invalid",
      from: 4,
      to: 9,
    });
  });

  it("places each problem on the text it is about", () => {
    expect(checkFormula("{Prix} * 2", refs)).toBeNull();
    expect(checkFormula("= {Prix} + {Taxe}", refs)).toEqual({
      code: "unknown_field",
      detail: "Taxe",
      from: 11,
      to: 17,
    });
    expect(checkFormula("roud({Prix})", refs)).toMatchObject({
      code: "unknown_function",
      from: 0,
      to: 4,
    });
    expect(checkFormula("round()", refs)).toMatchObject({
      code: "invalid_arguments",
      detail: "round",
      from: 0,
      to: 5,
    });
    expect(checkFormula("({Prix} + 1", refs)).toMatchObject({
      code: "missing_closing_parenthesis",
      from: 11,
      to: 11,
    });
    expect(checkFormula("1 # 2", refs)).toMatchObject({
      code: "unexpected_character",
      detail: "#",
      from: 2,
      to: 3,
    });
  });
});
