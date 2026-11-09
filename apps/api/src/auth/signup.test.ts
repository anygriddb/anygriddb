import { describe, expect, it } from "vitest";
import { signupInputSchema } from "./signup.js";

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
});
