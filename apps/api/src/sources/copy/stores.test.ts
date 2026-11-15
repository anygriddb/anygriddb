import { describe, expect, it } from "vitest";
import { redisCell, redisPrefix } from "./redis.js";

describe("a Redis prefix", () => {
  it("keeps a prefix that names some keys", () => {
    expect(redisPrefix("shop:")).toBe(true);
  });

  it("refuses a prefix that would read every key", () => {
    expect(redisPrefix("")).toBe(false);
    expect(redisPrefix("*")).toBe(false);
    expect(redisPrefix("rev*")).toBe(false);
    expect(redisPrefix("a b")).toBe(false);
  });
});

describe("a Redis value", () => {
  it("keeps a whole number, and the digits of one a number cannot hold", () => {
    expect(redisCell("2")).toBe(2);
    expect(redisCell("9007199254740993")).toBe("9007199254740993");
  });

  it("keeps a document as its JSON text", () => {
    expect(redisCell('{"sku":"A-1","lines":[{"qty":1}]}')).toBe(
      '{"sku":"A-1","lines":[{"qty":1}]}',
    );
  });
});
