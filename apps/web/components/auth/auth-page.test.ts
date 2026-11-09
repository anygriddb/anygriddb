import { describe, expect, it } from "vitest";
import { safeNext } from "./auth-page";

describe("safeNext", () => {
  it("keeps an in-app path and rejects auth loops and off-site values", () => {
    expect(safeNext("/bases/1")).toBe("/bases/1");
    expect(safeNext("/login")).toBe("/");
    expect(safeNext("/login?next=%2F")).toBe("/");
    expect(safeNext("/signup")).toBe("/");
    expect(safeNext("/login#top")).toBe("/");
    expect(safeNext("/bases/1?view=2")).toBe("/bases/1?view=2");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
  });
});
