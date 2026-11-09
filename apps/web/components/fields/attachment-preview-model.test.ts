import { describe, expect, it } from "vitest";
import { isPreviewableImage, stepFile } from "./attachment-preview-model";

describe("attachment preview", () => {
  it("shows the images the server sends inline and wraps between files", () => {
    expect(isPreviewableImage("image/webp")).toBe(true);
    expect(isPreviewableImage("IMAGE/PNG")).toBe(true);
    expect(stepFile(2, 1, 3)).toBe(0);
    expect(stepFile(0, -1, 3)).toBe(2);
  });

  it("offers any other type as a download", () => {
    // SVG can carry script, and the server sends it as a download.
    expect(isPreviewableImage("image/svg+xml")).toBe(false);
    expect(isPreviewableImage("application/pdf")).toBe(false);
    expect(stepFile(0, 1, 0)).toBe(0);
  });
});
