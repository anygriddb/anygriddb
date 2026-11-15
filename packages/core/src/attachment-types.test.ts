import { describe, expect, it } from "vitest";
import {
  attachmentExtensionOf,
  attachmentIsRefused,
  normalizeAttachmentExtension,
} from "./attachment-types";

describe("attachment refuse lists", () => {
  it("normalises extensions with a leading dot", () => {
    expect(normalizeAttachmentExtension("EXE")).toBe(".exe");
    expect(normalizeAttachmentExtension(".bat")).toBe(".bat");
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

  it("accepts every file when the lists are empty", () => {
    expect(
      attachmentIsRefused({
        filename: "virus.exe",
        mime: "application/octet-stream",
        refusedExtensions: [],
        refusedMimes: [],
      }),
    ).toBe(false);
  });

  it("refuses by extension or by sniffed type", () => {
    expect(
      attachmentIsRefused({
        filename: "setup.EXE",
        mime: "application/octet-stream",
        refusedExtensions: [".exe"],
        refusedMimes: [],
      }),
    ).toBe(true);
    expect(
      attachmentIsRefused({
        filename: "notes.bin",
        mime: "application/x-msdownload",
        refusedExtensions: [],
        refusedMimes: ["application/x-msdownload"],
      }),
    ).toBe(true);
    expect(
      attachmentIsRefused({
        filename: "photo.jpg",
        mime: "image/jpeg",
        refusedExtensions: [".exe"],
        refusedMimes: ["application/x-msdownload"],
      }),
    ).toBe(false);
  });
});
