import { describe, expect, it } from "vitest";
import { firstRunStep } from "./first-run";

describe("firstRunStep", () => {
  it("moves on once the account is protected", () => {
    expect(
      firstRunStep({ secured: true, skipped: false, factorNeeded: true }),
    ).toBe(2);
  });

  it("lets a person skip when nothing requires a factor", () => {
    expect(
      firstRunStep({ secured: false, skipped: true, factorNeeded: false }),
    ).toBe(2);
  });

  it("keeps the first step while a required factor is missing", () => {
    expect(
      firstRunStep({ secured: false, skipped: true, factorNeeded: true }),
    ).toBe(1);
    expect(
      firstRunStep({ secured: false, skipped: false, factorNeeded: false }),
    ).toBe(1);
  });
});
