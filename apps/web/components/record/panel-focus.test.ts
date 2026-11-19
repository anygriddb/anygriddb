import { describe, expect, it } from "vitest";
import { givesKeyboardBack, takesKeyboard } from "./panel-focus";

describe("takesKeyboard", () => {
  it("takes it when a row opens from the page, or from nowhere", () => {
    expect(takesKeyboard("page")).toBe(true);
    expect(takesKeyboard("nowhere")).toBe(true);
  });

  it("leaves it where it is in the panel: on the button to the next row", () => {
    expect(takesKeyboard("panel")).toBe(false);
  });
});

describe("givesKeyboardBack", () => {
  it("gives it back to what opened the row, once closing left it nowhere", () => {
    expect(givesKeyboardBack("nowhere", true)).toBe(true);
  });

  it("keeps the place of a person who went on to something else", () => {
    expect(givesKeyboardBack("page", true)).toBe(false);
  });

  it("gives it to nothing when what opened the row is gone", () => {
    expect(givesKeyboardBack("nowhere", false)).toBe(false);
  });
});
