import { describe, expect, it } from "vitest";
import { exactFloatText, ROW_FLOATS, withExactFloats } from "./float-text";

describe("exactFloatText", () => {
  it("gives a double its shortest exact decimal", () => {
    expect(exactFloatText("d1.0000000000000001E-1")).toBe("0.1");
    expect(exactFloatText("d1.0000000000000000E-11")).toBe("0.00000000001");
    expect(exactFloatText("d1.234567890123456E-1")).toBe("0.1234567890123456");
    expect(exactFloatText("d1.0000000000000000E+27")).toBe(
      "1000000000000000000000000000",
    );
    expect(exactFloatText("d0.0E0")).toBe("0");
    expect(exactFloatText("d-2.5E0")).toBe("-2.5");
  });

  it("gives a single-precision float its own shortest decimal", () => {
    expect(exactFloatText("f1.00000001E-1")).toBe("0.1");
    expect(exactFloatText("f1.67772160E+7")).toBe("16777216");
    expect(exactFloatText("f1.23456700E+5")).toBe("123456.7");
  });

  it("keeps a stored decimal as it is written", () => {
    expect(exactFloatText("n.00000000001")).toBe("0.00000000001");
    expect(exactFloatText("n1.0E-011")).toBe("0.00000000001");
    expect(exactFloatText("n12345678901234567890.5")).toBe(
      "12345678901234567890.5",
    );
  });

  it("refuses what is no number, never guessing one", () => {
    expect(exactFloatText("dNaN")).toBeUndefined();
    expect(exactFloatText("dInf")).toBeUndefined();
    expect(exactFloatText("x1")).toBeUndefined();
    expect(exactFloatText("")).toBeUndefined();
  });
});

describe("withExactFloats", () => {
  it("puts each exact text in its field and removes the carrier", () => {
    const row = withExactFloats({
      id: 1,
      m: "0.0000000000",
      n: null,
      [ROW_FLOATS]: { m: "d1.0000000000000000E-11", n: null },
    });
    expect(row).toEqual({ id: 1, m: "0.00000000001", n: null });
  });

  it("leaves a row without the carrier alone", () => {
    const row = { id: 1, m: "2" };
    expect(withExactFloats(row)).toBe(row);
  });
});
