import { describe, expect, it } from "vitest";
import { publicSiem, type SiemRow } from "./siem.js";

describe("publicSiem", () => {
  it("hides the secret and marks a saved row", () => {
    const row: SiemRow = {
      url: "https://siem.example.org/hooks/anygriddb",
      secretCiphertext: Buffer.from("cipher"),
      secretNonce: Buffer.from("nonce"),
      updatedAt: new Date("2026-11-11T00:00:00.000Z"),
      updatedBy: null,
    };
    const shown = publicSiem(row);
    expect(shown).toEqual({
      configured: true,
      url: "https://siem.example.org/hooks/anygriddb",
      hasSecret: true,
      updatedAt: "2026-11-11T00:00:00.000Z",
    });
    expect(JSON.stringify(shown)).not.toContain("cipher");
  });

  it("reports an empty instance", () => {
    expect(publicSiem(null)).toEqual({
      configured: false,
      url: null,
      hasSecret: false,
      updatedAt: null,
    });
  });
});
