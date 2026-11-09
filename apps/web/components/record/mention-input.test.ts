import { describe, expect, it } from "vitest";
import { mentionQuery } from "./mention-input";

describe("mentionQuery", () => {
  it("finds the word typed after @ at the caret", () => {
    expect(mentionQuery("Merci @Ad", 9)).toEqual({ start: 6, query: "Ad" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("ignores emails, finished mentions, and text after the caret", () => {
    expect(mentionQuery("ada@example", 11)).toBeNull();
    expect(mentionQuery("@[Ada](x) ok", 12)).toBeNull();
    expect(mentionQuery("salut @Ada bonjour", 18)).toBeNull();
  });
});
