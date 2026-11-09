import { describe, expect, it } from "vitest";
import { cleanFilename, contentDisposition } from "./attachments.js";

describe("attachment names", () => {
  it("keeps a printable base name and encodes it for the header", () => {
    expect(cleanFilename("../../etc/passwd")).toBe("passwd");
    expect(cleanFilename('C:\\photos\\vacances "été".jpg')).toBe(
      "vacances été.jpg",
    );
    expect(contentDisposition("été.png", true)).toBe(
      `inline; filename="_t_.png"; filename*=UTF-8''%C3%A9t%C3%A9.png`,
    );
  });

  it("falls back to a neutral name and forces downloads for unsafe types", () => {
    expect(cleanFilename("\u0000\u0007")).toBe("fichier");
    expect(cleanFilename(undefined)).toBe("fichier");
    expect(contentDisposition("page.html", false)).toMatch(/^attachment; /);
  });
});
