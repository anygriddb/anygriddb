import { describe, expect, it } from "vitest";
import { logUrl } from "./log-url.js";

describe("logUrl", () => {
  it("masks the secret part of a secret address", () => {
    expect(logUrl(`/hooks/automations/aghook_${"a".repeat(43)}`)).toBe(
      "/hooks/automations/…",
    );
    expect(logUrl(`/ical/agcal_${"b".repeat(43)}.ics`)).toBe("/ical/…");
    expect(logUrl("/s/share-token")).toBe("/s/…");
    expect(logUrl("/invite/abc?next=%2F")).toBe("/invite/…?…");
  });

  it("keeps other paths, without their query string", () => {
    expect(logUrl("/trpc/share.view?input=%7B%22token%22%3A%22x%22%7D")).toBe(
      "/trpc/share.view?…",
    );
    expect(logUrl("/b/1/t/2")).toBe("/b/1/t/2");
    expect(logUrl("/health")).toBe("/health");
    expect(logUrl("/sitemap#x")).toBe("/sitemap?…");
  });
});
