/**
 * Attachment MIME policy shared by the API (serve / sniff) and the web
 * preview. Every accepted type has a preview kind; anything else is a
 * download only. What an administrator may refuse (ROADMAP #39) is a
 * list of extensions and sniffed types: empty means every file is taken.
 */

export const ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
] as const;
type AttachmentPreviewKind = "image" | "pdf" | "text";

const IMAGE_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const INLINE_TYPES = new Set<string>(ATTACHMENT_TYPES);

/** A file extension as stored: lower case, with the leading dot. */
export function normalizeAttachmentExtension(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const withDot = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  // Letters and digits only after the dot; no path tricks.
  if (!/^\.[a-z0-9]{1,16}$/.test(withDot)) return null;
  return withDot;
}

/** Extension of a file name, or null when it has none. */
export function attachmentExtensionOf(filename: string): string | null {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return normalizeAttachmentExtension(base.slice(dot));
}

/**
 * Whether a file is refused by the administrator's lists. Empty lists
 * refuse nothing. A match on the extension or on the sniffed MIME is
 * enough; both are compared lower case.
 */
export function attachmentIsRefused(input: {
  filename: string;
  mime: string;
  refusedExtensions: readonly string[];
  refusedMimes: readonly string[];
}): boolean {
  const mime = input.mime.trim().toLowerCase();
  if (
    mime &&
    input.refusedMimes.some((entry) => entry.trim().toLowerCase() === mime)
  ) {
    return true;
  }
  const ext = attachmentExtensionOf(input.filename);
  if (!ext) return false;
  return input.refusedExtensions.some(
    (entry) => normalizeAttachmentExtension(entry) === ext,
  );
}

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
