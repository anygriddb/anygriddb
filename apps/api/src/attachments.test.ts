import { describe, expect, it } from "vitest";
import {
  attachmentFrameHeaders,
  attachmentResponseMode,
  cleanFilename,
  contentDisposition,
} from "./attachments.js";

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

describe("attachment framing", () => {
  it("allows same-origin framing for an inline PDF only", () => {
    const frame = attachmentFrameHeaders("application/pdf", true);
    expect(frame?.frameOptions).toBe("SAMEORIGIN");
    expect(frame?.csp).toContain("frame-ancestors 'self'");
    expect(attachmentFrameHeaders("APPLICATION/PDF", true)?.frameOptions).toBe(
      "SAMEORIGIN",
    );
  });

  it("keeps clickjacking denial for images and forced downloads", () => {
    expect(attachmentFrameHeaders("image/png", true)).toBeNull();
    expect(attachmentFrameHeaders("application/pdf", false)).toBeNull();
  });
});

describe("attachment response mode", () => {
  it("serves accepted types inline and forces download when asked", () => {
    expect(attachmentResponseMode("text/plain", {})).toMatchObject({
      inline: true,
      contentType: "text/plain",
      frame: null,
    });
    expect(attachmentResponseMode("application/pdf", {})).toMatchObject({
      inline: true,
      contentType: "application/pdf",
    });
    expect(
      attachmentResponseMode("application/pdf", {}).frame?.frameOptions,
    ).toBe("SAMEORIGIN");
    expect(
      attachmentResponseMode("application/pdf", { forceDownload: true }),
    ).toMatchObject({
      inline: false,
      contentType: "application/pdf",
      frame: null,
    });
    expect(
      attachmentResponseMode("application/octet-stream", {}),
    ).toMatchObject({
      inline: false,
      contentType: "application/octet-stream",
      frame: null,
    });
  });
});
