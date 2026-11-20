import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CatalogColumn, Collaborator } from "../../lib/types";
import { CellValueView } from "./cell-value";

i18n.load("en", {});
i18n.activate("en");

const people = new Map(
  [
    { id: "u1", displayName: "Ada Lovelace" },
    { id: "u2", displayName: "Bob Kahn" },
  ].map((person): [string, Collaborator] => [person.id, person]),
);

const column = (patch: Record<string, unknown>) =>
  ({
    name: "field",
    label: "Field",
    fieldType: "text",
    kind: "text",
    config: {},
    ...patch,
  }) as unknown as CatalogColumn;

/** The text of a piece of markup: what lies outside its tags. */
function textIn(markup: string): string {
  let text = "";
  let inTag = false;
  for (const character of markup) {
    if (character === "<") inTag = true;
    else if (character === ">") inTag = false;
    else if (!inTag) text += character;
  }
  return text;
}

/** What a cell reads as: the text of what it draws. */
function textOf(value: unknown, of: CatalogColumn): string {
  return textIn(
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        { i18n },
        createElement(CellValueView, {
          value,
          column: of,
          locale: "en",
          people,
        }),
      ),
    ),
  );
}

describe("CellValueView", () => {
  it("parts the things a cell holds by a space, as its name does by a comma", () => {
    expect(
      textOf(
        ["Red", "Green", "Blue"],
        column({ fieldType: "multi_select", kind: "options" }),
      ),
    ).toBe("Red Green Blue");
    expect(
      textOf(
        [
          { id: "r1", label: "Bolt" },
          { id: "r2", label: "Nut" },
        ],
        column({ fieldType: "link", kind: "links" }),
      ),
    ).toBe("Bolt Nut");
    // A person's chip holds their initials, then their name.
    expect(
      textOf(["u1", "u2"], column({ fieldType: "user", kind: "users" })),
    ).toBe("ALAda Lovelace BKBob Kahn");
  });

  it("adds nothing to a cell that holds one thing, or none", () => {
    expect(
      textOf(["Red"], column({ fieldType: "multi_select", kind: "options" })),
    ).toBe("Red");
    expect(textOf("Red", column({ fieldType: "single_select" }))).toBe("Red");
    expect(
      textOf([], column({ fieldType: "multi_select", kind: "options" })),
    ).toBe("");
    expect(textOf("One text", column({}))).toBe("One text");
  });
});
