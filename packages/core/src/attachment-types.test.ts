import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_TYPES,
  attachmentPreviewKind,
  isImageAttachmentMime,
  isInlineAttachmentMime,
} from "./attachment-types";

describe("attachment MIME policy", () => {
  it("gives every accepted type an inline preview kind", () => {
    for (const mime of ATTACHMENT_TYPES) {
      expect(isInlineAttachmentMime(mime)).toBe(true);
      expect(attachmentPreviewKind(mime)).not.toBeNull();
    }
    expect(attachmentPreviewKind("IMAGE/JPEG")).toBe("image");
    expect(attachmentPreviewKind("application/pdf")).toBe("pdf");
    expect(attachmentPreviewKind("text/plain")).toBe("text");
    expect(isImageAttachmentMime("image/webp")).toBe(true);
    expect(isImageAttachmentMime("application/pdf")).toBe(false);
  });

  it("rejects types that must stay downloads", () => {
    expect(attachmentPreviewKind("image/svg+xml")).toBeNull();
    expect(attachmentPreviewKind("application/octet-stream")).toBeNull();
    expect(attachmentPreviewKind("text/html")).toBeNull();
    expect(isInlineAttachmentMime("image/svg+xml")).toBe(false);
  });
});
