import { describe, expect, it } from "vitest";
import { CODE128_MAX_CHARS, code128 } from "./code128";

const drawn = (text: string) =>
  (code128(text) ?? []).map((bar) => (bar ? "1" : "0")).join("");

describe("code128", () => {
  it("draws a start, each character, a check symbol, and a stop", () => {
    // Start B, "A", the check symbol (here the one of "B"), the stop.
    expect(drawn("A")).toBe(
      "11010010000" + "10100011000" + "10001011000" + "1100011101011",
    );
    expect(drawn("AB")).toBe(
      "110100100001010001100010001011000111101011101100011101011",
    );
    expect(drawn("Hello")).toBe(
      "110100100001100010100010110010000110010100001100101000010001111010110010100001100011101011",
    );
  });

  it("is eleven modules a symbol, thirteen for the stop", () => {
    for (const text of [
      "x",
      "Sample-0042/A",
      "~}|{`_^]\\[@?>=<;:/.-,+*)('&%$#\"!",
    ]) {
      expect(drawn(text)).toHaveLength((text.length + 2) * 11 + 13);
    }
  });

  it("draws nothing for what the set cannot write, or a scanner read", () => {
    expect(code128("")).toBeNull();
    expect(code128("café")).toBeNull();
    expect(code128("a\tb")).toBeNull();
    expect(code128("x".repeat(CODE128_MAX_CHARS))).not.toBeNull();
    expect(code128("x".repeat(CODE128_MAX_CHARS + 1))).toBeNull();
  });
});
