import { describe, expect, it } from "vitest";
import {
  INSTANCE_LOGO_MAX_BYTES,
  instanceLogoInputSchema,
  instanceLogoType,
} from "./instance-logo";

const bytes = (...values: number[]) => Uint8Array.from(values);

describe("instanceLogoType", () => {
  it("names an image by its first bytes", () => {
    expect(
      instanceLogoType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    ).toBe("image/png");
    expect(instanceLogoType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(
      instanceLogoType(
        bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50),
      ),
    ).toBe("image/webp");
  });

  it("refuses markup, a cut signature, and nothing at all", () => {
    expect(
      instanceLogoType(new TextEncoder().encode("<svg xmlns=")),
    ).toBeNull();
    expect(instanceLogoType(bytes(0x89, 0x50, 0x4e))).toBeNull();
    // RIFF, but a sound file.
    expect(
      instanceLogoType(
        bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45),
      ),
    ).toBeNull();
    expect(instanceLogoType(bytes())).toBeNull();
  });
});

describe("instanceLogoInputSchema", () => {
  it("takes base64 up to the largest logo", () => {
    const largest = "A".repeat(Math.ceil(INSTANCE_LOGO_MAX_BYTES / 3) * 4);
    expect(instanceLogoInputSchema.safeParse({ data: largest }).success).toBe(
      true,
    );
  });

  it("refuses more, an empty image, and what is not base64", () => {
    const tooLong = "A".repeat(Math.ceil(INSTANCE_LOGO_MAX_BYTES / 3) * 4 + 4);
    expect(instanceLogoInputSchema.safeParse({ data: tooLong }).success).toBe(
      false,
    );
    expect(instanceLogoInputSchema.safeParse({ data: "" }).success).toBe(false);
    expect(instanceLogoInputSchema.safeParse({ data: "<svg>" }).success).toBe(
      false,
    );
  });
});
