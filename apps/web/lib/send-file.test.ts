import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileRefused,
  formFileUrl,
  refusalOf,
  sendFile,
  tableFileUrl,
} from "./send-file";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refusalOf", () => {
  it("names each refusal a form says differently", () => {
    expect(refusalOf(413)).toBe("too_large");
    expect(refusalOf(503)).toBe("busy");
    expect(refusalOf(429)).toBe("too_many");
  });

  it("calls anything else a refusal", () => {
    expect(refusalOf(404)).toBe("refused");
    expect(refusalOf(500)).toBe("refused");
  });
});

describe("file addresses", () => {
  it("encodes a form's field and a table's id", () => {
    expect(formFileUrl("tok_en-1", "Pièces jointes")).toBe(
      "/api/shares/tok_en-1/attachments?field=Pi%C3%A8ces%20jointes",
    );
    expect(tableFileUrl("a/b")).toBe("/api/attachments?tableId=a%2Fb");
  });
});

describe("sendFile", () => {
  it("sends the file as multipart and keeps the key, name, and size", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = init.body as FormData;
      const sent = body.get("file") as File;
      return Response.json({
        key: "attAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        filename: sent.name,
        size: sent.size,
        mime: "text/plain",
      });
    });
    vi.stubGlobal("fetch", fetch);
    const sent = await sendFile(
      "/api/shares/t/attachments?field=f",
      new File(["hello"], "note.txt"),
      { "x-share-access": "proof" },
    );
    expect(sent).toEqual({
      key: "attAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      filename: "note.txt",
      size: 5,
    });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "x-share-access": "proof" },
    });
  });

  it("throws the refusal when the server says no", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 413 })),
    );
    await expect(
      sendFile("/api/attachments?tableId=x", new File(["x"], "big.bin")),
    ).rejects.toEqual(new FileRefused("too_large"));
  });
});
