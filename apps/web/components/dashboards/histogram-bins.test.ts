import { describe, expect, it } from "vitest";
import { binLabels } from "./histogram-bins";

describe("the names of a histogram's bins", () => {
  it("are each bin's two bounds, the last ending on the greatest value", () => {
    expect(binLabels({ lo: 0, hi: 100 }, 4, "en")).toEqual([
      "0 – 25",
      "25 – 50",
      "50 – 75",
      "75 – 100",
    ]);
    expect(binLabels({ lo: -10, hi: 10 }, 2, "en")).toEqual([
      "-10 – 0",
      "0 – 10",
    ]);
    // Thirds do not add up to the greatest value: it is written as it is.
    expect(binLabels({ lo: 0, hi: 1 }, 3, "en").at(-1)).toBe("0.67 – 1");
  });

  it("keep the decimals that tell two bounds apart, and no more", () => {
    expect(binLabels({ lo: 0, hi: 25 }, 3, "en")).toEqual([
      "0 – 8.3",
      "8.3 – 16.7",
      "16.7 – 25",
    ]);
    expect(binLabels({ lo: 0.001, hi: 0.002 }, 2, "en")).toEqual([
      "0.001 – 0.0015",
      "0.0015 – 0.002",
    ]);
    expect(binLabels({ lo: 0, hi: 2_000_000 }, 2, "en")).toEqual([
      "0 – 1,000,000",
      "1,000,000 – 2,000,000",
    ]);
  });

  it("are written in the reader's language", () => {
    expect(binLabels({ lo: 0, hi: 5 }, 2, "fr")).toEqual([
      "0 – 2,5",
      "2,5 – 5",
    ]);
  });

  it("are one name when every value is the same", () => {
    expect(binLabels({ lo: 7, hi: 7 }, 12, "en")).toEqual(["7"]);
    expect(binLabels({ lo: 7.5, hi: 9 }, 1, "en")).toEqual(["7.5"]);
  });
});
