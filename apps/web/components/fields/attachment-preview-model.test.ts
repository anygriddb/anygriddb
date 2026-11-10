import { describe, expect, it } from "vitest";
import {
  attachmentPreviewKind,
  isPreviewableImage,
  isPreviewablePdf,
  isPreviewableText,
  stepFile,
} from "./attachment-preview-model";

describe("attachment preview", () => {
  it("shows the images, PDFs, and text the server sends inline and wraps between files", () => {
    expect(isPreviewableImage("image/webp")).toBe(true);
    expect(isPreviewableImage("IMAGE/PNG")).toBe(true);
    expect(isPreviewablePdf("application/pdf")).toBe(true);
    expect(isPreviewablePdf("APPLICATION/PDF")).toBe(true);
    expect(isPreviewableText("text/plain")).toBe(true);
    expect(attachmentPreviewKind("text/plain")).toBe("text");
    expect(stepFile(2, 1, 3)).toBe(0);
    expect(stepFile(0, -1, 3)).toBe(2);
  });

  it("offers any other type as a download", () => {
    // SVG can carry script, and the server sends it as a download.
    expect(isPreviewableImage("image/svg+xml")).toBe(false);
    expect(isPreviewablePdf("image/png")).toBe(false);
    expect(isPreviewablePdf("application/octet-stream")).toBe(false);
    expect(isPreviewableText("text/html")).toBe(false);
    expect(attachmentPreviewKind("application/octet-stream")).toBeNull();
    expect(stepFile(0, 1, 0)).toBe(0);
  });
});
