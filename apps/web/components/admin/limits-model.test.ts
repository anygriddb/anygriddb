import { describe, expect, it } from "vitest";
import { limitsFromDraft } from "./limits-model";

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
});
