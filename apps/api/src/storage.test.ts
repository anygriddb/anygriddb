import { describe, expect, it } from "vitest";
import { sniffContentType } from "./storage.js";

describe("sniffContentType", () => {
  it("recognizes image bytes before the stored type", () => {
    expect(
      sniffContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])),
    ).toBe("image/png");
    expect(sniffContentType(Buffer.from("hello"), "text/plain")).toBe(
      "text/plain",
    );
    expect(sniffContentType(Buffer.from("hello"), "text/html")).toBe(
      "application/octet-stream",
    );
  });
});
