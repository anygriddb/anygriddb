import { attachmentPreviewKind } from "@anygriddb/core";

export {
  attachmentPreviewKind,
  type AttachmentPreviewKind,
} from "@anygriddb/core";

export function isPreviewableImage(mime: string): boolean {
  return attachmentPreviewKind(mime) === "image";
}

export function isPreviewablePdf(mime: string): boolean {
  return attachmentPreviewKind(mime) === "pdf";
}

export function isPreviewableText(mime: string): boolean {
  return attachmentPreviewKind(mime) === "text";
}

/** The file `delta` steps away, wrapping at both ends. */
export function stepFile(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}
