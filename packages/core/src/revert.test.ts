import { describe, expect, it } from "vitest";
import { cellFromAudit, earlierChanges, withExactNumbers } from "./revert";

const base = (name: string) => ({ id: "base", name, description: null });

describe("earlierChanges", () => {
  it("offers the name a base had before an edit", () => {
    const listed = earlierChanges({
      kind: "base",
      oldValue: base("Ledger"),
      newValue: base("Ledger 2"),
    });
    expect(listed.changes).toEqual([
      {
        field: "name",
        before: "Ledger",
        after: "Ledger 2",
        canRevert: true,
      },
    ]);
    expect(listed.canRevertAll).toBe(true);
  });

  it("offers nothing once a field's type is no longer the one in the event", () => {
    const listed = earlierChanges({
      kind: "column",
      oldValue: { id: "col", label: "Title", field_type: "text" },
      newValue: { id: "col", label: "Title", field_type: "long_text" },
      closed: true,
    });
    expect(listed.changes.every((change) => !change.canRevert)).toBe(true);
    expect(listed.canRevertAll).toBe(false);
  });
});

describe("cellFromAudit", () => {
  it("turns a JSON document and a number back into cells", () => {
    expect(cellFromAudit("json", { ok: true })).toBe('{"ok":true}');
    expect(cellFromAudit("number", 12.5)).toBe("12.5");
  });

  it("refuses a value that is not a cell", () => {
    expect(() => cellFromAudit("text", { ok: true })).toThrow(
      "This cannot be put back",
    );
  });
});

describe("withExactNumbers", () => {
  it("puts back the digits a float changed, and nothing else", () => {
    expect(
      withExactNumbers(
        { big: 9007199254740992, plain: 12.5, name: "a" },
        { big: "9007199254740993", plain: "12.50" },
      ),
    ).toEqual({ big: "9007199254740993", plain: 12.5, name: "a" });
  });

  it("keeps the text of a number too long to be a decimal here", () => {
    const digits = "1".repeat(70);
    expect(withExactNumbers({ big: Number(digits) }, { big: digits })).toEqual({
      big: digits,
    });
  });

  it("leaves what holds no numbers as it is", () => {
    expect(withExactNumbers(null, null)).toBeNull();
    expect(withExactNumbers({ a: 1 }, null)).toEqual({ a: 1 });
  });
});
