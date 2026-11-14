import { describe, expect, it } from "vitest";
import { encode } from "uqr";
import { qrPath } from "./qr-path";

describe("qrPath", () => {
  it("draws each run of dark modules once", () => {
    expect(
      qrPath([
        [true, true, false],
        [false, true, true],
      ]),
    ).toBe("M0 0h2v1h-2zM1 1h2v1h-2z");
  });

  it("draws nothing for a blank matrix", () => {
    expect(qrPath([[false, false], []])).toBe("");
  });

  it("draws an authenticator address as a square code", () => {
    const qr = encode(
      "otpauth://totp/AnyGridDB:ada%40example.org?secret=JBSWY3DPEHPK3PXP&issuer=AnyGridDB",
      { ecc: "M", border: 0 },
    );
    expect(qr.data).toHaveLength(qr.size);
    expect(qrPath(qr.data).startsWith("M0 0h7v1h-7z")).toBe(true);
  });
});
