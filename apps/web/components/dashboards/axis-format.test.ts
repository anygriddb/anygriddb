import { describe, expect, it } from "vitest";
import { axisFormat } from "./axis-format";

/** Intl parts a number with narrow and no-break spaces: read as one kind. */
const plain = (text: string) => text.replace(/\s/g, " ");

describe("axisFormat", () => {
  it("writes a field of euros with its currency, short past ten thousand", () => {
    const format = axisFormat(
      "fr-FR",
      { style: "currency", currency: "EUR", precision: 2 },
      false,
    );
    expect(plain(format(500))).toBe("500 €");
    expect(plain(format(0.5))).toBe("0,5 €");
    expect(plain(format(12_500))).toBe("12,5 k €");
  });

  it("writes a count as a number, whatever the field", () => {
    const format = axisFormat("en-GB", undefined, false);
    expect(format(500)).toBe("500");
    expect(format(12_500)).toBe("12.5k");
  });

  it("signs a share of rows and a field of percentages", () => {
    expect(axisFormat("en-GB", undefined, true)(40)).toBe("40 %");
    expect(axisFormat("en-GB", { style: "percent" }, false)(40)).toBe("40 %");
  });

  it("leaves out a currency Intl does not take", () => {
    const format = axisFormat(
      "en-GB",
      { style: "currency", currency: "euro" },
      false,
    );
    expect(format(500)).toBe("500");
  });
});
