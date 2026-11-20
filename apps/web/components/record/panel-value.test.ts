import { describe, expect, it } from "vitest";
import { panelDrawing } from "./panel-value";

const drawn = (
  fieldType: string,
  value: unknown,
  appearance: "check" | "switch" | "yes_no" | null = null,
  failed = false,
) => panelDrawing({ fieldType, appearance, value, failed });

describe("panelDrawing", () => {
  it("says a field that holds nothing has no value", () => {
    expect(drawn("text", null)).toEqual({ kind: "blank" });
    expect(drawn("text", "")).toEqual({ kind: "blank" });
    expect(drawn("multi_select", [])).toEqual({ kind: "blank" });
    expect(drawn("text", "Ada")).toEqual({ kind: "value", value: "Ada" });
    // Zero is a value, as is "no".
    expect(drawn("number", 0)).toEqual({ kind: "value", value: 0 });
  });

  it("draws a checkbox never ticked as a box not ticked", () => {
    // A grid leaves the cell empty; a line of the panel that showed
    // nothing said nothing of what a click on it does.
    expect(drawn("boolean", null, "check")).toEqual({ kind: "unticked" });
    expect(drawn("boolean", false, "check")).toEqual({ kind: "unticked" });
    expect(drawn("boolean", true, "check")).toEqual({
      kind: "value",
      value: true,
    });
  });

  it("leaves a switch and a yes or no to their own drawing of not ticked", () => {
    for (const appearance of ["switch", "yes_no"] as const) {
      expect(drawn("boolean", null, appearance)).toEqual({
        kind: "value",
        value: false,
      });
      expect(drawn("boolean", true, appearance)).toEqual({
        kind: "value",
        value: true,
      });
    }
  });

  it("draws a rating never given as none of its stars", () => {
    expect(drawn("rating", null)).toEqual({ kind: "value", value: 0 });
    expect(drawn("rating", 3)).toEqual({ kind: "value", value: 3 });
  });

  it("leaves an error to be drawn as one, whatever the field", () => {
    expect(drawn("boolean", null, "check", true)).toEqual({
      kind: "value",
      value: null,
    });
    expect(drawn("text", null, null, true)).toEqual({
      kind: "value",
      value: null,
    });
  });
});
