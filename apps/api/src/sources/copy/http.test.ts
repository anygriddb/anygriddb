import { describe, expect, it } from "vitest";
import { parsedJson } from "./http.js";

describe("the JSON of a store's answer", () => {
  it("keeps an integer past 2^53 exact, as text", () => {
    expect(
      parsedJson(
        '{"a":9007199254740993,"b":-9007199254740993,"c":18446744073709551615}',
      ),
    ).toEqual({
      a: "9007199254740993",
      b: "-9007199254740993",
      c: "18446744073709551615",
    });
  });

  it("keeps a safe integer and an ordinary double as numbers", () => {
    expect(parsedJson('{"a":9007199254740991,"b":1234567890123456.5}')).toEqual(
      { a: 9007199254740991, b: 1234567890123456.5 },
    );
    expect(parsedJson('{"a":1e300,"b":12345678901234567e2}')).toEqual({
      a: 1e300,
      b: Number("12345678901234567e2"),
    });
  });

  it("finds them inside lists and objects", () => {
    expect(parsedJson('{"a":[{"b":9007199254740993}]}')).toEqual({
      a: [{ b: "9007199254740993" }],
    });
  });

  it("answers null for what is not JSON", () => {
    expect(parsedJson("not json")).toBeNull();
    expect(parsedJson("")).toBeNull();
  });
});
