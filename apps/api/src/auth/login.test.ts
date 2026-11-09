import { describe, expect, it } from "vitest";
import { loginInputSchema } from "./login.js";

describe("login input", () => {
  it("accepts a bounded email and password and rejects everything else", () => {
    expect(
      loginInputSchema.safeParse({
        email: "ada@example.com",
        password: "correct horse",
      }).success,
    ).toBe(true);
    expect(
      loginInputSchema.safeParse({ email: "ada@example.com", password: "" })
        .success,
    ).toBe(false);
    expect(
      loginInputSchema.safeParse({
        email: "ada@example.com",
        password: "x".repeat(129),
      }).success,
    ).toBe(false);
    expect(
      loginInputSchema.safeParse({
        email: "ada@example.com\n",
        password: "secret",
      }).success,
    ).toBe(false);
    expect(
      loginInputSchema.safeParse({
        email: `${"a".repeat(250)}@example.com`,
        password: "secret",
      }).success,
    ).toBe(false);
  });
});
