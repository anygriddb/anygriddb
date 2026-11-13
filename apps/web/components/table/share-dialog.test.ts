import { describe, expect, it } from "vitest";
import { embedCode, parseEmbedSites } from "./share-dialog";

describe("embedding a shared link", () => {
  it("reads the sites typed, apart by spaces, commas, or lines", () => {
    expect(
      parseEmbedSites(
        " https://portal.example.org,https://wiki.example.org\nhttps://intranet.example ",
      ),
    ).toEqual([
      "https://portal.example.org",
      "https://wiki.example.org",
      "https://intranet.example",
    ]);
    expect(parseEmbedSites("  ")).toEqual([]);
  });

  it("writes the frame a site pastes, with the view's name made safe", () => {
    expect(
      embedCode("https://grid.example.org/s/abc", 'Sign up "now" & win'),
    ).toBe(
      '<iframe src="https://grid.example.org/s/abc" title="Sign up &quot;now&quot; &amp; win" loading="lazy" style="width: 100%; height: 600px; border: 0"></iframe>',
    );
  });
});
