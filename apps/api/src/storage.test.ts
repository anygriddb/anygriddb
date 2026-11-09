import { describe, expect, it } from "vitest";
import { decodeAttachment, sniffContentType } from "./storage.js";

describe("decodeAttachment", () => {
  it("accepts a small payload and rejects an empty one", () => {
    expect(decodeAttachment(Buffer.from("hello").toString("base64"))).toEqual(
      Buffer.from("hello"),
    );
    expect(() => decodeAttachment("")).toThrow(/Invalid attachment/);
  });

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
