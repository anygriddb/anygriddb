import { describe, expect, it } from "vitest";
import { recoveryInputSchema } from "./admin-recovery.js";

describe("what `admin recover` takes", () => {
  it("takes an address alone, and changes nothing more unless asked", () => {
    expect(recoveryInputSchema.parse({ email: "ada@example.org" })).toEqual({
      email: "ada@example.org",
      clearFactors: false,
      anyAddress: false,
    });
    expect(
      recoveryInputSchema.parse({
        email: "ada@example.org",
        create: " Ada Lovelace ",
        clearFactors: true,
        anyAddress: true,
      }),
    ).toEqual({
      email: "ada@example.org",
      create: "Ada Lovelace",
      clearFactors: true,
      anyAddress: true,
    });
  });

  it("refuses what is no address, no name, or a key it does not know", () => {
    for (const input of [
      {},
      { email: "ada" },
      { email: `${"a".repeat(250)}@example.org` },
      { email: "ada@example.org", create: "" },
      { email: "ada@example.org", create: "-Ada" },
      { email: "ada@example.org", create: "A".repeat(81) },
      { email: "ada@example.org", password: "typed on the command line" },
    ]) {
      expect(recoveryInputSchema.safeParse(input).success).toBe(false);
    }
  });
});
