import { z } from "zod";

/**
 * The instance's logo (ADR 0072): one small image an administrator
 * uploads, shown wherever the product's mark is. Pixels only: a drawing
 * made of markup could carry a script to every sign-in page.
 */
export const INSTANCE_LOGO_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type InstanceLogoType = (typeof INSTANCE_LOGO_TYPES)[number];

/** Largest logo taken: it is drawn 32 px high. */
export const INSTANCE_LOGO_MAX_BYTES = 262_144;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0) {
  return signature.every((byte, index) => bytes[at + index] === byte);
}

/**
 * What the first bytes prove the image to be, or null. What an upload
 * says of itself is never asked: the type served is the type found here.
 */
export function instanceLogoType(bytes: Uint8Array): InstanceLogoType | null {
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // "RIFF", four bytes of length, then "WEBP".
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return null;
}

/** The image, base64: a third longer than its bytes. */
export const instanceLogoInputSchema = z
  .object({
    data: z
      .base64()
      .min(1)
      .max(Math.ceil(INSTANCE_LOGO_MAX_BYTES / 3) * 4),
  })
  .strict();
