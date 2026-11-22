import { describe, expect, it } from "vitest";
import { CopyBuffer } from "./copy-buffer";

const cells = [[{ fieldType: "number", value: "1.23456789012" }]];

describe("copy buffer", () => {
  it("gives back the cells of the text it was given", () => {
    const buffer = new CopyBuffer();
    buffer.keep("1.23", cells);
    expect(buffer.recall("1.23")).toBe(cells);
  });

  it("reads through the line endings a clipboard may change", () => {
    const buffer = new CopyBuffer();
    buffer.keep("a\nb", cells);
    expect(buffer.recall("a\r\nb\r\n")).toBe(cells);
  });

  it("gives nothing for a text changed elsewhere", () => {
    const buffer = new CopyBuffer();
    buffer.keep("1.23", cells);
    expect(buffer.recall("1.24")).toBeNull();
    expect(buffer.recall("")).toBeNull();
  });

  it("holds the last copy only", () => {
    const buffer = new CopyBuffer();
    buffer.keep("1.23", cells);
    buffer.keep("other", []);
    expect(buffer.recall("1.23")).toBeNull();
  });

  it("forgets what it held", () => {
    const buffer = new CopyBuffer();
    buffer.keep("1.23", cells);
    buffer.clear();
    expect(buffer.recall("1.23")).toBeNull();
  });
});
