import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_TYPES,
  attachmentExtensionOf,
  attachmentIsRefused,
  attachmentKindOf,
  attachmentPreviewKind,
  isImageAttachmentMime,
  isInlineAttachmentMime,
  normalizeAttachmentExtension,
} from "./attachment-types";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("attachment MIME policy", () => {
  it("gives every accepted type an inline preview kind", () => {
    for (const mime of ATTACHMENT_TYPES) {
      expect(isInlineAttachmentMime(mime)).toBe(true);
      expect(attachmentPreviewKind(mime)).not.toBeNull();
    }
    expect(attachmentPreviewKind("IMAGE/JPEG")).toBe("image");
    expect(attachmentPreviewKind("application/pdf")).toBe("pdf");
    expect(attachmentPreviewKind("text/plain")).toBe("text");
    expect(isImageAttachmentMime("image/webp")).toBe(true);
    expect(isImageAttachmentMime("application/pdf")).toBe(false);
  });

  it("rejects types that must stay downloads", () => {
    expect(attachmentPreviewKind("image/svg+xml")).toBeNull();
    expect(attachmentPreviewKind("application/octet-stream")).toBeNull();
    expect(attachmentPreviewKind("text/html")).toBeNull();
    expect(isInlineAttachmentMime("image/svg+xml")).toBe(false);
  });
});

describe("attachment extensions", () => {
  it("normalises an extension with a leading dot", () => {
    expect(normalizeAttachmentExtension("EXE")).toBe(".exe");
    expect(normalizeAttachmentExtension(".bat")).toBe(".bat");
  });

  it("refuses an extension that is not one", () => {
    expect(normalizeAttachmentExtension("../x")).toBeNull();
    expect(normalizeAttachmentExtension("")).toBeNull();
  });

  it("reads the extension of a file name", () => {
    expect(attachmentExtensionOf("report.PDF")).toBe(".pdf");
    expect(attachmentExtensionOf("notes.tar.gz")).toBe(".gz");
    expect(attachmentExtensionOf("folder/setup.EXE")).toBe(".exe");
    expect(attachmentExtensionOf("noext")).toBeNull();
    expect(attachmentExtensionOf(".hidden")).toBeNull();
  });
});

describe("a file's kind, from its first bytes", () => {
  it("tells a program on each system", () => {
    expect(attachmentKindOf(new Uint8Array([0x4d, 0x5a, 0x90, 0]))).toBe(
      "program",
    );
    expect(attachmentKindOf(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBe(
      "program",
    );
    expect(attachmentKindOf(new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]))).toBe(
      "program",
    );
  });

  it("tells a script and a page, after a byte order mark or spaces", () => {
    expect(attachmentKindOf(bytes("#!/bin/sh\necho hi"))).toBe("script");
    expect(attachmentKindOf(bytes("﻿#!/usr/bin/env node"))).toBe("script");
    expect(attachmentKindOf(bytes("\n  <!DOCTYPE html><html>"))).toBe("page");
    expect(
      attachmentKindOf(bytes("<svg xmlns='http://www.w3.org/2000/svg'>")),
    ).toBe("page");
    expect(
      attachmentKindOf(bytes('<?xml version="1.0"?>\n<svg width="1">')),
    ).toBe("page");
  });

  it("gives no kind to a document, an image, or text", () => {
    expect(attachmentKindOf(bytes("%PDF-1.7"))).toBeNull();
    expect(
      attachmentKindOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])),
    ).toBeNull();
    // A zip is also every office document: never refused for what it is.
    expect(attachmentKindOf(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(
      null,
    );
    expect(attachmentKindOf(bytes("Name,Amount\nA,1"))).toBeNull();
    expect(attachmentKindOf(bytes("<p>not a page on its own</p>"))).toBeNull();
    expect(attachmentKindOf(new Uint8Array())).toBeNull();
  });
});

describe("what an administrator refuses", () => {
  const program = new Uint8Array([0x4d, 0x5a, 0x90, 0]);

  it("accepts every file when nothing is refused", () => {
    expect(
      attachmentIsRefused({
        filename: "setup.exe",
        head: program,
        refusedExtensions: [],
        refusedKinds: [],
      }),
    ).toBe(false);
  });

  it("refuses by extension, and by kind whatever the name", () => {
    expect(
      attachmentIsRefused({
        filename: "setup.EXE",
        head: bytes("text"),
        refusedExtensions: [".exe"],
        refusedKinds: [],
      }),
    ).toBe(true);
    expect(
      attachmentIsRefused({
        filename: "holiday.jpg",
        head: program,
        refusedExtensions: [],
        refusedKinds: ["program"],
      }),
    ).toBe(true);
  });

  it("takes a file that matches neither rule", () => {
    expect(
      attachmentIsRefused({
        filename: "photo.jpg",
        head: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
        refusedExtensions: [".exe"],
        refusedKinds: ["program", "script", "page"],
      }),
    ).toBe(false);
  });
});

describe("a name and a start that dress a file as something else", () => {
  it("reads the extension past trailing dots and spaces", () => {
    expect(attachmentExtensionOf("x.svg.")).toBe(".svg");
    expect(attachmentExtensionOf("x.svg ")).toBe(".svg");
    expect(attachmentExtensionOf("x.svg. . ")).toBe(".svg");
    expect(attachmentExtensionOf("x.")).toBeNull();
    expect(attachmentExtensionOf("...")).toBeNull();
  });

  it("tells a page behind a comment, a prologue, or a doctype", () => {
    for (const text of [
      "<!-- a note --><svg onload=x>",
      "<!-- é --> \n<html>",
      "<!-- one --><!-- two --><body>",
      '<?xml version="1.0"?><!-- a note --><svg>',
      '<?xml version="1.0"?><!DOCTYPE svg><svg/>',
      '<!DOCTYPE svg [ <!ENTITY a "b"> ]><svg>',
    ]) {
      expect(attachmentKindOf(bytes(text))).toBe("page");
    }
  });

  it("counts a comment still open at the end of what is read as a page", () => {
    expect(attachmentKindOf(bytes(`<!-- ${"x".repeat(600)}`))).toBe("page");
    expect(attachmentKindOf(bytes(`<?xml ${"x".repeat(600)}`))).toBe("page");
  });

  it("tells a page written in UTF-16, with or without its mark", () => {
    const utf16 = (text: string, big: boolean, mark: boolean) => {
      const units = [
        ...(mark ? [0xfeff] : []),
        ...Array.from({ length: text.length }, (_, at) => text.charCodeAt(at)),
      ];
      return Uint8Array.from(
        units.flatMap((unit) =>
          big ? [unit >> 8, unit & 0xff] : [unit & 0xff, unit >> 8],
        ),
      );
    };
    for (const big of [false, true]) {
      for (const mark of [true, false]) {
        expect(attachmentKindOf(utf16("<html><script>", big, mark))).toBe(
          "page",
        );
      }
      expect(attachmentKindOf(utf16("plain words", big, true))).toBeNull();
    }
  });

  it("gives no kind to a text that quotes a tag further on", () => {
    expect(attachmentKindOf(bytes("How to draw an <svg> element"))).toBeNull();
    expect(attachmentKindOf(bytes("é and then <html>"))).toBeNull();
    expect(attachmentKindOf(bytes('<?xml version="1.0"?><note/>'))).toBeNull();
    expect(attachmentKindOf(bytes("<!-- a note --><note/>"))).toBeNull();
  });

  it("refuses what a trailing dot or a space would let through", () => {
    for (const filename of ["x.svg.", "x.svg ", "X.SVG. "]) {
      expect(
        attachmentIsRefused({
          filename,
          head: bytes("harmless"),
          refusedExtensions: [".svg"],
          refusedKinds: [],
        }),
      ).toBe(true);
    }
    expect(
      attachmentIsRefused({
        filename: "x.svg.txt",
        head: bytes("harmless"),
        refusedExtensions: [".svg"],
        refusedKinds: [],
      }),
    ).toBe(false);
  });
});
