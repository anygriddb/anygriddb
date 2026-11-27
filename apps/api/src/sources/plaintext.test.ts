import { describe, expect, it } from "vitest";
import { connectionAllowsPlaintext } from "./types.js";

describe("connectionAllowsPlaintext", () => {
  it("follows the env lab flag or the source's own opt-in", () => {
    expect(
      connectionAllowsPlaintext(
        { allowPlaintext: false },
        { allowPlaintext: false },
      ),
    ).toBe(false);
    expect(
      connectionAllowsPlaintext(
        { allowPlaintext: true },
        { allowPlaintext: false },
      ),
    ).toBe(true);
    expect(
      connectionAllowsPlaintext(
        { allowPlaintext: false },
        { allowPlaintext: true },
      ),
    ).toBe(true);
  });
});
