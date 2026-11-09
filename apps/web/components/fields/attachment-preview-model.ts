/**
 * Image types the server sends inline (`apps/api/src/attachments.ts`):
 * the preview shows them; any other file is offered as a download.
 */
const INLINE_IMAGES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function isPreviewableImage(mime: string): boolean {
  return INLINE_IMAGES.has(mime.toLowerCase());
}

/** The file `delta` steps away, wrapping at both ends. */
export function stepFile(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}
