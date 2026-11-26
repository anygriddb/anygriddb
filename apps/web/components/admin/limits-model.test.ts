import { describe, expect, it } from "vitest";
import { limitsFromDraft, splitDraft } from "./limits-model";

describe("the limits saved from the page", () => {
  it("keeps what was typed within bounds, and what was set and left alone", () => {
    expect(
      limitsFromDraft(
        { "rate.auth": " 40 ", "rate.app": "3000" },
        { "rate.api": 1_000 },
      ),
    ).toEqual({ limits: { "rate.auth": 40, "rate.api": 1_000 } });
    // An emptied field goes back to the shipped value.
    expect(limitsFromDraft({ "rate.api": "" }, { "rate.api": 1_000 })).toEqual({
      limits: {},
    });
  });

  it("names a value past its bounds or not whole, and saves nothing", () => {
    expect(
      limitsFromDraft(
        { "rate.auth": "4", "rate.api": "60.5", "rate.share": "lots" },
        {},
      ),
    ).toEqual({ invalid: ["rate.auth", "rate.share", "rate.api"] });
  });

  it("keeps the rows of a file as typed, and one left alone as it was saved", () => {
    // A ceiling the environment fixes offers no field: what was saved for
    // it stays, unused while the variable is set.
    expect(
      limitsFromDraft(
        { "export.max_rows": "2500000" },
        { "import.max_rows": 3_000_000 },
      ),
    ).toEqual({
      limits: { "export.max_rows": 2_500_000, "import.max_rows": 3_000_000 },
    });
    expect(limitsFromDraft({ "import.max_rows": "99999" }, {})).toEqual({
      invalid: ["import.max_rows"],
    });
  });

  it("splits what is typed by the part of the page it is in", () => {
    expect(
      splitDraft({ "rate.auth": "40", "export.max_rows": "2500000" }, "files"),
    ).toEqual([{ "export.max_rows": "2500000" }, { "rate.auth": "40" }]);
    expect(splitDraft({ "rate.auth": "40" }, "kept")).toEqual([
      {},
      { "rate.auth": "40" },
    ]);
  });
});
