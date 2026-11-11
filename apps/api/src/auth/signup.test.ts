import { describe, expect, it } from "vitest";
import {
  factorProofSchema,
  signupInputSchema,
  totpConfirmSchema,
} from "./signup.js";

describe("signupInputSchema", () => {
  it("accepts a long password and rejects a short one", () => {
    expect(
      signupInputSchema.safeParse({
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        password: "correct horse",
      }).success,
    ).toBe(true);
    expect(
      signupInputSchema.safeParse({
        email: "ada@example.com",
        displayName: "Ada",
        password: "short",
      }).success,
    ).toBe(false);
  });

  it("accepts a factor proof and rejects a code that is not six digits", () => {
    expect(
      factorProofSchema.safeParse({ password: "correct horse" }).success,
    ).toBe(true);
    expect(factorProofSchema.safeParse({}).success).toBe(true);
    expect(factorProofSchema.safeParse({ factorCode: "12345" }).success).toBe(
      false,
    );
    expect(
      totpConfirmSchema.safeParse({
        secret: "JBSWY3DPEHPK3PXP",
        code: "123456",
        password: "correct horse",
      }).success,
    ).toBe(true);
  });
});
