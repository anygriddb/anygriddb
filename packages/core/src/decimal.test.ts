import { describe, expect, it } from "vitest";
import {
  decimalSeries,
  decimalToNumber,
  isDecimalString,
  numberToDecimal,
  toDecimalString,
} from "./decimal";

describe("exact decimals", () => {
  it("keeps every digit a float would lose", () => {
    expect(toDecimalString("9007199254740993")).toBe("9007199254740993");
    expect(toDecimalString("123456789012345.6789")).toBe(
      "123456789012345.6789",
    );
    expect(toDecimalString("0.1000000000000000055511151231257827")).toBe(
      "0.1000000000000000055511151231257827",
    );
  });

  it("writes one canonical form", () => {
    expect(toDecimalString("-0012.300")).toBe("-12.3");
    expect(toDecimalString("+5")).toBe("5");
    expect(toDecimalString("-0.0")).toBe("0");
    expect(toDecimalString(".5")).toBe("0.5");
    expect(toDecimalString("7.")).toBe("7");
  });

  it("expands scientific notation digit by digit", () => {
    expect(toDecimalString("1.5e3")).toBe("1500");
    expect(toDecimalString("1.5E-3")).toBe("0.0015");
    expect(toDecimalString("-2e0")).toBe("-2");
    expect(numberToDecimal(1e21)).toBe("1000000000000000000000");
    expect(numberToDecimal(Number.NaN)).toBeUndefined();
  });

  it("refuses what is not a number", () => {
    for (const text of ["", "abc", "1,5", "1.2.3", "--1", "e5", "."]) {
      expect(toDecimalString(text)).toBeUndefined();
    }
    expect(toDecimalString("1".repeat(61))).toBeUndefined();
    expect(isDecimalString("1.5")).toBe(true);
    expect(isDecimalString("1e3")).toBe(false);
    expect(isDecimalString(1.5)).toBe(false);
  });

  it("turns a decimal into a float only on request", () => {
    expect(decimalToNumber("12.5")).toBe(12.5);
    expect(decimalToNumber(3)).toBe(3);
    expect(decimalToNumber("x")).toBeUndefined();
    expect(decimalToNumber(null)).toBeUndefined();
  });
});

describe("exact series", () => {
  it("extends a series without float drift", () => {
    expect(decimalSeries("0.1", "0.2", 3)).toEqual(["0.3", "0.4", "0.5"]);
    expect(decimalSeries("1", "3", 3)).toEqual(["5", "7", "9"]);
    expect(decimalSeries("10", "7.5", 2)).toEqual(["5", "2.5"]);
    expect(decimalSeries("-1", "-2", 2)).toEqual(["-3", "-4"]);
    expect(decimalSeries("9007199254740991", "9007199254740992", 1)).toEqual([
      "9007199254740993",
    ]);
  });
});
