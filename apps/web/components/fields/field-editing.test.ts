import {
  FIELD_TYPES,
  isWritableType,
  prettyJson,
  readCellValue,
} from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
  blankAnswer,
  durationText,
  editableText,
  editingOf,
  opensPanel,
  takesLines,
} from "./field-editing";
import { isComputedField, isLinkField } from "./field-meta";

describe("how a field of each type is edited", () => {
  it("gives a value to what a person writes, and to nothing computed", () => {
    for (const type of FIELD_TYPES) {
      const { by } = editingOf(type);
      // Written by a person: typed, picked, ticked, or sent as files.
      expect(
        [
          "typing",
          "date",
          "rating",
          "options",
          "checkbox",
          "people",
          "files",
        ].includes(by),
        type,
      ).toBe(isWritableType(type));
      expect(by === "links", type).toBe(isLinkField(type));
      // Computed, kept by the system, or a button: nobody types into it.
      expect(by === "none" || by === "button", type).toBe(
        isComputedField(type),
      );
    }
    expect(editingOf("nonsense")).toEqual({ by: "none" });
  });

  it("opens a panel of choices for options, people, rows and files only", () => {
    expect(FIELD_TYPES.filter((type) => opensPanel(type))).toEqual([
      "single_select",
      "multi_select",
      "user",
      "attachment",
      "relation_one_to_many",
      "relation_many_to_many",
    ]);
    expect(opensPanel("text")).toBe(false);
    expect(opensPanel("nonsense")).toBe(false);
  });

  it("takes lines of their own in a long text and a document only", () => {
    expect(FIELD_TYPES.filter((type) => takesLines(type))).toEqual([
      "long_text",
      "json",
    ]);
  });

  it("asks a phone for the keyboard each typed value needs", () => {
    const typed = (type: string) => {
      const editing = editingOf(type);
      if (editing.by !== "typing") throw new Error(type);
      return editing;
    };
    expect(typed("email").input).toBe("email");
    expect(typed("url").input).toBe("url");
    expect(typed("phone").input).toBe("tel");
    expect(typed("number").digits).toBe(true);
    // `1:30` needs a colon, which a keyboard of digits does not have.
    expect(typed("duration").digits).toBeUndefined();
    expect(typed("text").input).toBe("text");
  });

  it("starts a form's answers empty, a list of options as none chosen", () => {
    expect(blankAnswer("multi_select")).toEqual([]);
    expect(blankAnswer("boolean")).toBe(false);
    expect(blankAnswer("single_select")).toBe("");
    expect(blankAnswer("user")).toBe("");
    expect(blankAnswer("text")).toBe("");
  });
});

describe("the text an editor opens on", () => {
  it("writes a number in the reader's language", () => {
    expect(editableText("1234.5", "number", "fr")).toBe("1234,5");
    expect(editableText("1234.5", "number", "en")).toBe("1234.5");
    expect(editableText(null, "number", "fr")).toBe("");
  });

  it("lays a document out", () => {
    // A document is read as its text.
    const text = '{"a":[1,2]}';
    expect(editableText(text, "json", "en")).toBe(prettyJson(text));
    expect(editableText(text, "json", "en")).toContain("\n");
    expect(editableText(text, "text", "en")).toBe(text);
  });

  it("keeps a duration's seconds, which the field may show", () => {
    expect(durationText(5400)).toBe("1:30");
    expect(durationText(3725)).toBe("1:02:05");
    expect(durationText(3725.5)).toBe("1:02:05.5");
    expect(durationText(0.001)).toBe("0:00:00.001");
    expect(durationText(90_000)).toBe("25:00");
    expect(editableText(3725, "duration", "en")).toBe("1:02:05");
    // A value the field does not keep is shown as it is, never as a clock.
    expect(editableText("soon", "duration", "en")).toBe("soon");
  });

  it("reads back, unchanged, the duration it wrote", () => {
    const column = { fieldType: "duration" as const, config: {} };
    for (const seconds of [0, 60, 5400, 3725, 3725.5, 86_399.999, 0.25]) {
      expect(
        readCellValue(column, durationText(seconds)),
        String(seconds),
      ).toEqual({ value: seconds });
    }
    // Sixty seconds is a minute: a clock never reads `:60`.
    expect(durationText(59.9996)).toBe("0:01");
    expect(readCellValue(column, "1:02:60")).toHaveProperty("refused");
  });
});
