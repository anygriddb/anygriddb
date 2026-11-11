import { describe, expect, it } from "vitest";
import { AppError } from "@anygriddb/core";
import {
  assertSignInAddressAllowed,
  SignInAllowList,
  parseSignInCidr,
} from "./sign-in-allowlist.js";

describe("sign-in allowlist", () => {
  it("parses addresses and CIDR ranges", () => {
    expect(parseSignInCidr("192.0.2.10")).toEqual({
      address: "192.0.2.10",
      family: 4,
    });
    expect(parseSignInCidr("192.0.2.0/24").bits).toBe(24);
    expect(() => parseSignInCidr("not-an-ip")).toThrow(AppError);
  });

  it("allows any address when empty, and filters when set", () => {
    expect(new SignInAllowList([]).allows("203.0.113.9")).toBe(true);
    const list = new SignInAllowList(["192.0.2.0/24"]);
    expect(list.allows("192.0.2.50")).toBe(true);
    expect(list.allows("203.0.113.9")).toBe(false);
    expect(() =>
      assertSignInAddressAllowed(["192.0.2.0/24"], "203.0.113.9"),
    ).toThrow(AppError);
  });
});
