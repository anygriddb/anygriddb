/**
 * Attachment MIME policy shared by the API (serve / sniff) and the web
 * preview. Every accepted type has a preview kind; anything else is a
 * download only. What an administrator may refuse (ROADMAP #39) is a
 * list of extensions, and kinds of file told by their first bytes,
 * whatever their name: nothing refused means every file is taken.
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
 * Kinds of file an administrator may refuse whatever they are named,
 * each told by its first bytes. A file of no kind here is one of the six
 * previewed types or a download, and is never refused for what it is.
 */
export const ATTACHMENT_REFUSABLE_KINDS = [
  "program",
  "script",
  "page",
] as const;
export type AttachmentRefusableKind =
  (typeof ATTACHMENT_REFUSABLE_KINDS)[number];

/** Bytes read from the start of a file to tell its kind. */
export const ATTACHMENT_HEAD_BYTES = 512;

/** Starts of a program: Windows, Linux and other Unix systems, macOS. */
const PROGRAM_MAGIC: readonly (readonly number[])[] = [
  [0x4d, 0x5a], // MZ: a Windows executable or library.
  [0x7f, 0x45, 0x4c, 0x46], // ELF.
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O, 32 and 64 bits, both byte orders.
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe], // A universal macOS binary, or a Java class.
];

/** Opening tags of a page a browser would run. */
const PAGE_START = /^<(?:!doctype\s+html|html|head|body|script|svg)[\s>/]/i;

function startsWith(head: Uint8Array, magic: readonly number[]): boolean {
  return (
    head.length >= magic.length && magic.every((byte, at) => head[at] === byte)
  );
}

/**
 * The kind of a file, from its first bytes, or null when it is none of
 * those an administrator may refuse.
 */
export function attachmentKindOf(
  head: Uint8Array,
): AttachmentRefusableKind | null {
  if (PROGRAM_MAGIC.some((magic) => startsWith(head, magic))) return "program";
  // A UTF-8 byte order mark, then the text.
  const offset = startsWith(head, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  if (head[offset] === 0x23 && head[offset + 1] === 0x21) return "script";
  let text = "";
  for (const byte of head.subarray(offset)) {
    if (byte > 0x7e) break;
    text += String.fromCharCode(byte);
  }
  const start = text.trimStart();
  if (PAGE_START.test(start)) return "page";
  // An XML file whose root is a drawing: an SVG holds scripts too.
  if (/^<\?xml[\s\S]*?<svg[\s>/]/i.test(start)) return "page";
  return null;
}

/**
 * Whether a file is refused by the administrator's rules: its extension,
 * or its kind told by its bytes. Nothing refused refuses nothing.
 */
export function attachmentIsRefused(input: {
  filename: string;
  head: Uint8Array;
  refusedExtensions: readonly string[];
  refusedKinds: readonly AttachmentRefusableKind[];
}): boolean {
  if (input.refusedKinds.length > 0) {
    const kind = attachmentKindOf(input.head);
    if (kind && input.refusedKinds.includes(kind)) return true;
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
