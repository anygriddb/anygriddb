import { describe, expect, it } from "vitest";
import { lostToCodePage } from "./kept-text.js";

describe("lostToCodePage", () => {
  it("sees characters replaced by a code page", () => {
    expect(lostToCodePage("日本語 🎉", "??? ??")).toBe(true);
    expect(lostToCodePage("Prix 日本", "Prix ??")).toBe(true);
    expect(lostToCodePage("🎉", "?")).toBe(true);
    expect(lostToCodePage("Ā1", "A1")).toBe(true);
    expect(lostToCodePage("été", "ete")).toBe(true);
  });

  it("accepts a text kept whole, a CHAR's padding included", () => {
    expect(lostToCodePage("é€", "é€")).toBe(false);
    expect(lostToCodePage("日本語 🎉", "日本語 🎉")).toBe(false);
    expect(lostToCodePage("abc", "abc       ")).toBe(false);
    expect(lostToCodePage("été", "été   ")).toBe(false);
  });

  it("leaves a client's own trigger alone", () => {
    expect(lostToCodePage("zoë", "ZOË")).toBe(false);
    expect(lostToCodePage("été", "ÉTÉ")).toBe(false);
    expect(lostToCodePage("plain?", "PLAIN")).toBe(false);
    expect(lostToCodePage("prix 10 €", "prix: 10 €")).toBe(false);
    expect(lostToCodePage("abc", null)).toBe(false);
  });
});
