import { AppError } from "@anygriddb/core";
import { describe, expect, it, vi } from "vitest";
import {
  RELEASE_FEED_URL,
  checkLatestRelease,
  compareSemVer,
} from "./release-check.js";

describe("compareSemVer", () => {
  it("orders MAJOR.MINOR.PATCH", () => {
    expect(compareSemVer("0.1.0", "0.1.0")).toBe(0);
    expect(compareSemVer("0.1.0", "0.1.1")).toBe(-1);
    expect(compareSemVer("0.2.0", "0.1.9")).toBe(1);
    expect(compareSemVer("1.0.0", "0.9.9")).toBe(1);
  });

  it("refuses a non-SemVer string", () => {
    expect(() => compareSemVer("1.0", "1.0.0")).toThrow(AppError);
  });
});

describe("checkLatestRelease", () => {
  it("refuses when the feed is unreachable", async () => {
    await expect(
      checkLatestRelease("0.1.0", {
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toMatchObject({ code: "release_check_failed" });
  });

  it("reports when a newer release exists", async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe(RELEASE_FEED_URL);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: "v0.2.0",
          html_url:
            "https://github.com/anygriddb/anygriddb/releases/tag/v0.2.0",
          prerelease: false,
          draft: false,
        }),
      };
    });
    await expect(checkLatestRelease("0.1.0", { fetch })).resolves.toEqual({
      current: "0.1.0",
      latest: "0.2.0",
      newer: true,
      url: "https://github.com/anygriddb/anygriddb/releases/tag/v0.2.0",
    });
  });

  it("reports when this build is current", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: "v0.1.0",
        html_url: "https://github.com/anygriddb/anygriddb/releases/tag/v0.1.0",
        prerelease: false,
        draft: false,
      }),
    }));
    await expect(checkLatestRelease("0.1.0", { fetch })).resolves.toMatchObject(
      { newer: false, latest: "0.1.0" },
    );
  });

  it("refuses a draft or prerelease feed", async () => {
    await expect(
      checkLatestRelease("0.1.0", {
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: "v0.2.0",
            html_url: "https://example.test/r",
            prerelease: true,
            draft: false,
          }),
        }),
      }),
    ).rejects.toMatchObject({ code: "release_check_failed" });
  });
});
