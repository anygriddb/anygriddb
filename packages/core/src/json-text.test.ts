import { describe, expect, it } from "vitest";
import { assertCellValue, coerceCellValue } from "./cell-values";
import { isConvertible, isMetadataConversion } from "./query/conversion";
import { isSideFieldType, sideColumnType } from "./query/external-write";
import {
  JSON_MAX_CHARS,
  JSON_MAX_DEPTH,
  jsonCellText,
  parseJsonDocument,
  prettyJson,
} from "./json-text";

const column = { fieldType: "json" as const, config: {} };

describe("the document a JSON field keeps", () => {
  it("is an object or a list, a space after each colon and comma", () => {
    expect(parseJsonDocument('{"a":1,"b":[true,null,"x"]}')).toBe(
      '{"a": 1, "b": [true, null, "x"]}',
    );
    expect(parseJsonDocument(' {\n  "a" : 1 ,\n  "b" : { }\n} ')).toBe(
      '{"a": 1, "b": {}}',
    );
    expect(parseJsonDocument("[ ]")).toBe("[]");
    // What it reads from its own spelling is that spelling.
    const kept = '{"a": [1, {"b": "c, d: e"}], "f": "{\\"g\\":1}"}';
    expect(parseJsonDocument(kept)).toBe(kept);
  });

  it("keeps a number and a string as they were written", () => {
    expect(
      parseJsonDocument('{"big":12345678901234567890123,"exact":1.50}'),
    ).toBe('{"big": 12345678901234567890123, "exact": 1.50}');
    // Spaces, brackets and escaped quotes inside a string are its own.
    expect(parseJsonDocument('["a  b",":,{}[]","q\\"r\\\\"]')).toBe(
      '["a  b", ":,{}[]", "q\\"r\\\\"]',
    );
    expect(parseJsonDocument('{"é":"日本"}')).toBe('{"é": "日本"}');
  });

  it("is no bare value, and nothing that is not JSON", () => {
    for (const text of [
      "",
      "12",
      '"text"',
      "true",
      "null",
      "{bad",
      "{'a':1}",
      '{"a":1,}',
      "[1,2",
      '{"a":1} trailing',
      "hello",
    ]) {
      expect([text, parseJsonDocument(text)]).toEqual([text, undefined]);
    }
  });

  it("holds no text the database refuses in a document", () => {
    // JSON takes a nul and half of a surrogate pair; PostgreSQL's jsonb
    // takes neither, and the write ended on its error.
    for (const text of [
      '{"a": "x\\u0000y"}',
      '{"a\\u0000": 1}',
      '["\\ud800"]',
      '{"\\udc00": [1]}',
      '{"a": {"b": ["ok", "half \\ud83d"]}}',
      ["{", '"a": "raw ', "\ud800", '"}'].join(""),
    ]) {
      expect([text, parseJsonDocument(text)]).toEqual([text, undefined]);
    }
    // A whole pair is a character like any other, written either way.
    expect(parseJsonDocument('{"a": "\\ud83d\\ude00 😀"}')).toBe(
      '{"a": "\\ud83d\\ude00 😀"}',
    );
    expect(() => assertCellValue(column, '{"a": "x\\u0000y"}')).toThrow();
  });

  it("nests and runs as far as every engine takes, and no further", () => {
    const nested = (depth: number) =>
      `${"[".repeat(depth)}${"]".repeat(depth)}`;
    expect(parseJsonDocument(nested(JSON_MAX_DEPTH))).toBe(
      nested(JSON_MAX_DEPTH),
    );
    expect(parseJsonDocument(nested(JSON_MAX_DEPTH + 1))).toBeUndefined();
    // Past what the parser itself takes: refused, not thrown.
    expect(parseJsonDocument(nested(200_000))).toBeUndefined();
    const fits = `["${"a".repeat(JSON_MAX_CHARS - 4)}"]`;
    expect(parseJsonDocument(fits)).toBe(fits);
    expect(parseJsonDocument(`["${"a".repeat(JSON_MAX_CHARS - 3)}"]`)).toBe(
      undefined,
    );
    // The length is that of the kept spelling: the spaces of a document
    // laid out do not count against it.
    const laidOut = `[\n${" ".repeat(JSON_MAX_CHARS)}1\n]`;
    expect(parseJsonDocument(laidOut)).toBe("[1]");
  });
});

describe("a document laid out to be read", () => {
  it("puts a member and an item a line, two spaces a level", () => {
    expect(prettyJson('{"a": 1, "b": [true, {"c": null}], "d": {}}')).toBe(
      [
        "{",
        '  "a": 1,',
        '  "b": [',
        "    true,",
        "    {",
        '      "c": null',
        "    }",
        "  ],",
        '  "d": {}',
        "}",
      ].join("\n"),
    );
    expect(prettyJson("[]")).toBe("[]");
    expect(prettyJson("[[1, 2], []]")).toBe(
      ["[", "  [", "    1,", "    2", "  ],", "  []", "]"].join("\n"),
    );
  });

  it("reads back as the document it was, numbers untouched", () => {
    const kept = '{"big": 12345678901234567890123, "s": "a: b, c"}';
    expect(parseJsonDocument(prettyJson(kept))).toBe(kept);
  });

  it("leaves a text that is no document as it is", () => {
    expect(prettyJson("not json")).toBe("not json");
    expect(prettyJson("12")).toBe("12");
  });
});

describe("a document the change trail kept", () => {
  it("comes back as the text of a cell", () => {
    expect(jsonCellText({ a: 1, b: [true] })).toBe('{"a": 1, "b": [true]}');
    expect(jsonCellText(["x"])).toBe('["x"]');
    expect(jsonCellText('{"a": 1}')).toBe('{"a": 1}');
    expect(jsonCellText(null)).toBe("");
    expect(jsonCellText(12)).toBe("");
  });
});

describe("a JSON field's cell", () => {
  it("takes a document however it is spaced, and refuses the rest", () => {
    expect(() => assertCellValue(column, '{"a": 1}')).not.toThrow();
    expect(() => assertCellValue(column, '{\n  "a":1\n}')).not.toThrow();
    expect(() => assertCellValue(column, null)).not.toThrow();
    for (const value of ["{bad", "12", '"a"', "null", 12, true, ["a"]]) {
      expect(() => assertCellValue(column, value)).toThrow("Invalid cell");
    }
  });

  it("reads what a person types into its one spelling", () => {
    expect(coerceCellValue(column, ' { "a" : [ 1 , 2 ] } ')).toBe(
      '{"a": [1, 2]}',
    );
    // A list sent as a list is the document.
    expect(coerceCellValue(column, ["a", "b"])).toBe('["a", "b"]');
    expect(coerceCellValue(column, "")).toBeNull();
    expect(coerceCellValue(column, "   ")).toBeNull();
    expect(coerceCellValue(column, "{bad")).toBeUndefined();
    expect(coerceCellValue(column, "12")).toBeUndefined();
    expect(coerceCellValue(column, 12)).toBeUndefined();
  });
});

describe("a JSON field among the others", () => {
  it("is converted from and to a text, by rewriting the column", () => {
    expect(isConvertible("long_text", "json")).toBe(true);
    expect(isConvertible("json", "long_text")).toBe(true);
    expect(isMetadataConversion("long_text", "json")).toBe(false);
    expect(isMetadataConversion("json", "text")).toBe(false);
    expect(isConvertible("json", "attachment")).toBe(false);
  });

  it("is kept beside a client's table, in each engine's own type", () => {
    expect(isSideFieldType("json")).toBe(true);
    expect(
      (["postgres", "mysql", "mariadb", "sqlserver", "oracle"] as const).map(
        (engine) => sideColumnType(engine, "json"),
      ),
    ).toEqual(["jsonb", "json", "json", "nvarchar(max)", "clob"]);
  });
});
