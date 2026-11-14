import { describe, expect, it } from "vitest";
import { byteSize } from "./format-bytes";

describe("byteSize", () => {
  it("reads a size in the binary unit that fits it", () => {
    expect(byteSize(0)).toEqual({ value: 0, unit: "B" });
    expect(byteSize(1023)).toEqual({ value: 1023, unit: "B" });
    expect(byteSize(1536)).toEqual({ value: 1.5, unit: "KiB" });
    expect(byteSize(5 * 1024 ** 2)).toEqual({ value: 5, unit: "MiB" });
    expect(byteSize(2 * 1024 ** 3)).toEqual({ value: 2, unit: "GiB" });
    expect(byteSize(3 * 1024 ** 4)).toEqual({ value: 3, unit: "TiB" });
    // 1,023.96 KiB would round to "1,024.0 KiB": it is said in MiB.
    expect(byteSize(1023.96 * 1024).unit).toBe("MiB");
  });

  it("reads what is not a size as no bytes", () => {
    expect(byteSize(-1)).toEqual({ value: 0, unit: "B" });
    expect(byteSize(Number.NaN)).toEqual({ value: 0, unit: "B" });
    expect(byteSize(Number.POSITIVE_INFINITY)).toEqual({ value: 0, unit: "B" });
  });
});
