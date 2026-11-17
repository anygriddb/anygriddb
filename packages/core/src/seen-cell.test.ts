import { describe, expect, it } from "vitest";
import { sameAsSeen } from "./seen-cell";

describe("a cell compared with what its writer saw", () => {
  it("takes a value read twice the same way", () => {
    expect(sameAsSeen("text", "Ada", "Ada")).toBe(true);
    expect(sameAsSeen("single_select", "Done", "Done")).toBe(true);
    expect(sameAsSeen("multi_select", ["a", "b"], ["a", "b"])).toBe(true);
  });

  it("refuses a value that moved", () => {
    expect(sameAsSeen("text", "Ada", "Grace")).toBe(false);
    expect(sameAsSeen("number", "12.5", "12.6")).toBe(false);
    expect(sameAsSeen("multi_select", ["a", "b"], ["b", "a"])).toBe(false);
    expect(sameAsSeen("boolean", true, false)).toBe(false);
    expect(sameAsSeen("text", "Ada", null)).toBe(false);
  });

  it("reads a number by its value, not its spelling", () => {
    expect(sameAsSeen("number", "12.50", 12.5)).toBe(true);
    expect(sameAsSeen("rating", 3, "3")).toBe(true);
  });

  it("reads every empty cell alike", () => {
    expect(sameAsSeen("text", null, "")).toBe(true);
    expect(sameAsSeen("text", undefined, null)).toBe(true);
    expect(sameAsSeen("multi_select", null, [])).toBe(true);
    expect(sameAsSeen("boolean", null, false)).toBe(true);
    expect(sameAsSeen("boolean", false, true)).toBe(false);
  });

  it("reads a file by its key, as it is written", () => {
    const read = [{ key: "k1", name: "a.pdf", size: 12 }, { key: "k2" }];
    expect(sameAsSeen("attachment", read, ["k1", "k2"])).toBe(true);
    expect(sameAsSeen("attachment", read, ["k1"])).toBe(false);
    expect(sameAsSeen("attachment", read, ["k2", "k1"])).toBe(false);
  });

  it("reads a moment however it is spelled", () => {
    expect(
      sameAsSeen(
        "datetime",
        "2026-01-05T10:00:00+00:00",
        "2026-01-05T10:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      sameAsSeen(
        "datetime",
        new Date("2026-01-05T10:00:00Z"),
        "2026-01-05 10:00:00Z",
      ),
    ).toBe(true);
    expect(sameAsSeen("date", "2026-01-05", "2026-01-05T00:00:00.000Z")).toBe(
      true,
    );
    expect(sameAsSeen("date", "2026-01-05", "2026-01-06")).toBe(false);
    // A text that looks like a date is a text.
    expect(sameAsSeen("text", "2026-01-05", "2026-01-05T00:00:00.000Z")).toBe(
      false,
    );
  });

  it("reads a document whatever order its keys come in", () => {
    expect(sameAsSeen("json", { a: 1, b: [1, 2] }, '{"b":[1,2],"a":1}')).toBe(
      true,
    );
    expect(sameAsSeen("json", { a: 1 }, { a: 2 })).toBe(false);
    expect(sameAsSeen("json", [{ a: 1 }], '[{"a":1}]')).toBe(true);
    expect(sameAsSeen("json", [{ a: 1 }], '[{"a":2}]')).toBe(false);
    expect(sameAsSeen("json", "not a document", "not a document")).toBe(true);
  });
});
