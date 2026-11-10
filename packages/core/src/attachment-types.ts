/**
 * Attachment MIME policy shared by the API (serve / sniff) and the web
 * preview. Every accepted type has a preview kind; anything else is a
 * download only.
 */

export const ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
] as const;

export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

export type AttachmentPreviewKind = "image" | "pdf" | "text";

const IMAGE_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const INLINE_TYPES = new Set<string>(ATTACHMENT_TYPES);

export function isImageAttachmentMime(mime: string): boolean {
  return IMAGE_TYPES.has(mime.toLowerCase());
}

export function isInlineAttachmentMime(mime: string): boolean {
  return INLINE_TYPES.has(mime.toLowerCase());
}

export function attachmentPreviewKind(
  mime: string,
): AttachmentPreviewKind | null {
  const type = mime.toLowerCase();
  if (IMAGE_TYPES.has(type)) return "image";
  if (type === "application/pdf") return "pdf";
  if (type === "text/plain") return "text";
  return null;
}
